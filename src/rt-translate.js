/* 消息翻译：/api/translate（引擎链可配置 + 文本哈希缓存全房间共享 + 限速/超时）
 * 引擎解析顺序：
 *   1. LOCALSEND_TRANSLATE_URL 显式指定（引擎在局域网任意机器时用）
 *      特殊值 'off'：显式关闭（不自动探测）
 *   2. 未设置 → 启动时自动探测本机默认地址 http://127.0.0.1:5000（零配置）
 *   3. LOCALSEND_TRANSLATE_GTX=1 → 允许回退谷歌免费端点（需外网，内容发送到第三方，默认关）
 *   4. 都不可用 → 翻译入口隐藏，接口 503
 */
const crypto = require('crypto');
const store = require('../db.js');

const ENV_URL = (process.env.LOCALSEND_TRANSLATE_URL || '').trim();
const GTX_ENABLED = process.env.LOCALSEND_TRANSLATE_GTX === '1';
const ENGINE_TIMEOUT = 10000;   // 引擎响应超时 10s
const MAX_TEXT_LEN = 5000;
const RATE_LIMIT_MS = 1000;     // 每 IP 最小请求间隔
const AUTODETECT_URL = 'http://127.0.0.1:5000';

let LT_URL = '';                // 解析后的 LibreTranslate 地址（detectEngine 后生效）
if (ENV_URL && ENV_URL.toLowerCase() !== 'off') {
  LT_URL = ENV_URL.replace(/\/+$/, '');
}

const lastRequestAt = new Map(); // ip -> ts（简单限速）

// CJK 字符占比：超过阈值视为"已是中文"，跳过翻译
function mostlyCJK(text) {
  const chars = String(text).replace(/\s+/g, '');
  if (!chars.length) return true;
  let cjk = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) cjk++;
  }
  return cjk / chars.length > 0.3;
}

function engineInfo() {
  if (LT_URL) return { available: true, engine: 'libretranslate', url: LT_URL };
  if (GTX_ENABLED) return { available: true, engine: 'gtx' };
  return { available: false, engine: null };
}

// 启动时引擎探测：未显式配置时尝试本机默认地址（短超时，绝不阻塞启动）
async function detectEngine() {
  if (LT_URL) {
    console.log(`  消息翻译:   libretranslate (${LT_URL})`);
    return;
  }
  if (ENV_URL.toLowerCase() === 'off') {
    console.log('  消息翻译:   已显式关闭（LOCALSEND_TRANSLATE_URL=off）');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const r = await fetch(`${AUTODETECT_URL}/languages`, { signal: controller.signal });
    if (r.ok) {
      LT_URL = AUTODETECT_URL;
      console.log(`  消息翻译:   自动发现本机 LibreTranslate (${AUTODETECT_URL})`);
      return;
    }
  } catch (_) { /* 本机无默认引擎 */ } finally {
    clearTimeout(timer);
  }
  if (GTX_ENABLED) {
    console.log('  消息翻译:   回退到谷歌免费端点（内容将发送到第三方）');
  } else {
    console.log('  消息翻译:   未发现引擎（LOCALSEND_TRANSLATE_URL 可指定；本机 5000 端口有 LibreTranslate 会自动接入）');
  }
}

// 目标语言代码映射：LibreTranslate 的中文代码是 zh-Hans
function ltTargetCode(target) {
  return target === 'zh' ? 'zh-Hans' : target;
}

async function callLibreTranslate(text, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT);
  try {
    const r = await fetch(`${LT_URL}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'auto', target: ltTargetCode(target), format: 'text' }),
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`翻译服务响应 ${r.status}`);
    const j = await r.json();
    if (!j || typeof j.translatedText !== 'string') throw new Error('翻译服务返回格式异常');
    return j.translatedText;
  } finally {
    clearTimeout(timer);
  }
}

async function callGtx(text, target) {
  const tl = target === 'zh' ? 'zh-CN' : target;
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t' +
    `&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`翻译端点响应 ${r.status}`);
    const j = await r.json();
    // gtx 返回 [[["译文","原文",...],...],...]
    const parts = j && j[0];
    if (!Array.isArray(parts)) throw new Error('翻译端点返回格式异常');
    return parts.map((seg) => (seg && seg[0]) || '').join('');
  } finally {
    clearTimeout(timer);
  }
}

async function translate(text, target) {
  const info = engineInfo();
  if (!info.available) throw new Error('翻译服务未配置');
  if (info.engine === 'libretranslate') {
    return { translation: await callLibreTranslate(text, target), engine: 'libretranslate' };
  }
  return { translation: await callGtx(text, target), engine: 'gtx' };
}

function registerRoutes(app) {
  // 翻译可用性探测（前端决定菜单项显隐）
  app.get('/api/translate/status', (req, res) => {
    const info = engineInfo();
    res.json({ ok: true, available: info.available, engine: info.engine });
  });

  app.post('/api/translate', require('express').json({ limit: '64kb' }), async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '';
    const now = Date.now();
    if (now - (lastRequestAt.get(ip) || 0) < RATE_LIMIT_MS) {
      return res.status(429).json({ ok: false, error: '请求太频繁，请稍后再试' });
    }
    lastRequestAt.set(ip, now);

    const text = String((req.body && req.body.text) || '').trim();
    const target = String((req.body && req.body.target) || 'zh');
    if (!text || text.length > MAX_TEXT_LEN) {
      return res.status(400).json({ ok: false, error: `文本需为 1~${MAX_TEXT_LEN} 字符` });
    }
    if (!['zh', 'en'].includes(target)) {
      return res.status(400).json({ ok: false, error: '暂只支持 zh / en 目标语言' });
    }
    if (!engineInfo().available) {
      return res.status(503).json({ ok: false, error: '翻译服务未配置（需设置 LOCALSEND_TRANSLATE_URL）' });
    }
    if (target === 'zh' && mostlyCJK(text)) {
      return res.json({ ok: true, skipped: 'already_target_lang', translation: text });
    }

    const hash = crypto.createHash('sha256').update(`${target}:${text}`).digest('hex').slice(0, 32);
    try {
      const hit = store.getTranslation(hash, target);
      if (hit) {
        return res.json({ ok: true, translation: hit.translation, engine: hit.engine, cached: true });
      }
    } catch (_) { /* 缓存查询失败不阻塞，直接走引擎 */ }

    try {
      const r = await translate(text, target);
      try { store.saveTranslation(hash, target, r.translation, r.engine); } catch (_) { /* 缓存写失败不阻塞 */ }
      res.json({ ok: true, translation: r.translation, engine: r.engine, cached: false });
    } catch (e) {
      const isAbort = e && e.name === 'AbortError';
      res.status(502).json({ ok: false, error: isAbort ? '翻译服务响应超时' : `翻译失败：${e.message}` });
    }
  });
}

module.exports = { registerRoutes, engineInfo, mostlyCJK, detectEngine };
