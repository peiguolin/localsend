/* 发言合规：禁言 + 限流的统一判定（Socket 文字与 HTTP 上传两条链路共用，避免分叉）。 */
const state = require('./state');
const { currentConfig } = require('./config');

// 返回 null 表示允许；否则返回拒绝原因（可直接回显给本人）
function checkAllowed(clientId) {
  const cid = String(clientId || '');

  // 禁言
  const until = state.mutes.get(cid) || 0;
  if (until > Date.now()) {
    return `你已被禁言，至 ${new Date(until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 后可发言`;
  } else if (until) {
    state.mutes.delete(cid); // 过期清理
  }

  // 限流（0=不限；窗口内超量拒绝，连续 3 次自动短禁言 1 分钟）
  const cfg = currentConfig();
  const limit = cfg.msgRateLimit || 0;
  const win = (cfg.msgRateWindowSec || 10) * 1000;
  if (cid && limit > 0) {
    const now = Date.now();
    const rec = state.rateHits.get(cid) || { times: [], strikes: 0, lastStrikeAt: 0 };
    rec.times = rec.times.filter((t) => now - t < win);
    if (rec.times.length >= limit) {
      rec.strikes++;
      rec.lastStrikeAt = now;
      if (rec.strikes >= 3) {
        state.mutes.set(cid, now + 60000);
        state.rateHits.set(cid, rec);
        return '发言过于频繁，已临时禁言 1 分钟';
      }
      state.rateHits.set(cid, rec);
      return '发送太频繁，请稍后再发';
    }
    rec.times.push(now);
    if (now - rec.lastStrikeAt > win) rec.strikes = 0; // 长时间未刷屏 → 衰减
    state.rateHits.set(cid, rec);
  }
  return null;
}

module.exports = { checkAllowed };
