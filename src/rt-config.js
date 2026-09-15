/* 配置中心管理接口（仅宿主机）：GET 当前生效配置 / POST 写入 localsend.config.json
 * translateUrl 即时生效（reload 翻译引擎）；其余项需重启，接口会标注 restartNeeded */
const { currentConfig, writeConfigFile, CONFIG_DEFS } = require('./config');
const { isLocalAddr } = require('./util');
const rtTranslate = require('./rt-translate');

function registerRoutes(app) {
  app.get('/api/config', (req, res) => {
    if (!isLocalAddr(req.ip || req.socket.remoteAddress)) {
      return res.status(403).json({ ok: false, error: '仅宿主机可查看配置' });
    }
    res.json({ ok: true, config: currentConfig() });
  });

  app.post('/api/config', require('express').json({ limit: '32kb' }), async (req, res) => {
    if (!isLocalAddr(req.ip || req.socket.remoteAddress)) {
      return res.status(403).json({ ok: false, error: '仅宿主机可修改配置' });
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
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: `保存失败：${e.message}` });
    }
  });
}

module.exports = { registerRoutes };
