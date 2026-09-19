/* 配置中心管理接口：GET 当前生效配置 / POST 写入 localsend.config.json
 * 权限：宿主机直连；或 invite 模式下 role='admin' 的登录账号（管理员权限分配）。
 * translateUrl 即时生效（reload 翻译引擎）；其余项需重启，接口会标注 restartNeeded */
const { currentConfig, writeConfigFile, CONFIG_DEFS } = require('./config');
const { isLocalAddr } = require('./util');
const rtTranslate = require('./rt-translate');
const store = require('../db.js');
const auth = require('./auth');

// 配置管理员判定：宿主机直连，或 invite 模式下持有 role='admin' 会话的登录账号
function isConfigAdmin(req) {
  if (isLocalAddr(req.ip || req.socket.remoteAddress)) return true;
  if (!auth.inviteEnabled()) return false;
  const sess = auth.validateSession(auth.extractToken(req));
  return !!(sess && sess.role === 'admin');
}

// 记录一次配置变更到审计日志（apiKey 只记键名不记值）
function auditConfig(keys, actor) {
  try {
    store.insertAudit({
      actor: actor || '宿主机(配置面板)', action: 'config', target: '',
      detail: '修改配置: ' + keys.join('、')
    });
  } catch (_) { /* DB 不可用不阻塞 */ }
}

function registerRoutes(app) {
  app.get('/api/config', (req, res) => {
    if (!isConfigAdmin(req)) {
      return res.status(403).json({ ok: false, error: '仅管理员可查看配置' });
    }
    const cfg = currentConfig();
    cfg.botApiKey = ''; // 只写不回显：API Key 不在面板回读，留空即表示保持原值
    cfg.adminPassword = ''; // 同上：管理口令不回显
    res.json({ ok: true, config: cfg });
  });

  app.post('/api/config', require('express').json({ limit: '32kb' }), async (req, res) => {
    if (!isConfigAdmin(req)) {
      return res.status(403).json({ ok: false, error: '仅管理员可修改配置' });
    }
    const updates = (req.body && req.body.config) || {};
    const keys = Object.keys(updates);
    if (!keys.length) return res.status(400).json({ ok: false, error: '没有要保存的配置项' });
    // 类型校验
    for (const k of keys) {
      if (!(k in CONFIG_DEFS)) return res.status(400).json({ ok: false, error: `未知配置项：${k}` });
      const d = CONFIG_DEFS[k];
      const v = updates[k];
      if (d.type === 'int' && !Number.isInteger(Number(v))) {
        return res.status(400).json({ ok: false, error: `${k} 需为整数` });
      }
      if (d.type === 'float' && !Number.isFinite(Number(v))) {
        return res.status(400).json({ ok: false, error: `${k} 需为数字` });
      }
    }
    try {
      const result = writeConfigFile(updates);
      // translateUrl 即时生效；其余项重启后生效
      if ('translateUrl' in updates) {
        await rtTranslate.reload();
      }
      const sess = auth.validateSession(auth.extractToken(req));
      auditConfig(keys, (sess && sess.username) || '宿主机(配置面板)');
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: `保存失败：${e.message}` });
    }
  });
}

module.exports = { registerRoutes };
