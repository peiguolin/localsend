/* 安全与健壮性守卫：
 *  - securityHeaders：轻量安全响应头 + CSP（不引第三方依赖）。应用全同源、无外部 CDN、无 eval，
 *    但有一个内联主题初始化脚本、JS 动态样式、blob:/data: 图片与媒体，故 CSP 据此放行最小集合。
 *  - installProcessGuards：兜底未捕获的 Promise rejection / 同步异常，带时间戳记录，致命错误走优雅退出。 */

// Content-Security-Policy：
//  default-src 'self'      一切默认只允许同源
//  script-src 'self' 'unsafe-inline'  仅放行那一段内联主题初始化脚本（无 eval/new Function）
//  style-src  'self' 'unsafe-inline'  JS 会直接写 element.style / 注入样式
//  img-src   self + data: + blob:    灯箱/待发托盘/机器人 base64 视觉图
//  media-src self + blob:            语音消息与 WebRTC 本地/远端 blob 播放
//  font-src  'self' data:
//  connect-src 'self'（含同源 ws/wss 与 /api、/images 等；socket.io 走同源）
//  worker-src 'self' blob:；object-src 'none'；frame-ancestors 'none'；base-uri 'self'
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), interest-cohort=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
}

function ts() {
  return new Date().toISOString();
}

// 进程级兜底。onFatal：致命错误时调用（server.js 传入优雅退出）；不提供则只记录。
function installProcessGuards(onFatal) {
  // Promise 未捕获 rejection：记录但默认不退出（多为单个异步任务失败，不应拖垮整个服务）。
  // 若后续证实某类错误必须退出，可在此按错误类型分流。
  process.on('unhandledRejection', (reason) => {
    try {
      console.error(`[${ts()}] unhandledRejection:`, reason && reason.stack ? reason.stack : reason);
    } catch (_) { /* 记录本身不应再抛 */ }
  });

  // 同步未捕获异常：状态可能已不一致，记录后优雅退出（由进程管理器/手动重启拉起）。
  process.on('uncaughtException', (err) => {
    try {
      console.error(`[${ts()}] uncaughtException（致命，准备退出）:`, err && err.stack ? err.stack : err);
    } catch (_) { /* ignore */ }
    if (typeof onFatal === 'function') {
      try { onFatal('uncaughtException'); } catch (_) { process.exit(1); }
    } else {
      process.exit(1);
    }
  });
}

module.exports = { securityHeaders, installProcessGuards, CSP };
