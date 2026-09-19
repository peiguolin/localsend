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

// ---------- Socket 事件频率闸（按连接；只丢弃超限包，不踢人） ----------
// 白板笔迹/光标本就是高频且内容已钳制（cursor 还有 15ms 节流），ICE 在建连时会成批到达——
// 这些豁免；其余"动作类"事件用宽松的滑动窗口挡住异常洪泛/刷接口，阈值远高于正常人手操作。
const SOCKET_TIER = {
  // 豁免：高频实时流，不在此限（各自有内容钳制/节流）
  exempt: new Set([
    'wb_pts', 'wb_cursor', 'rtc_ice', 'ss_ice'
  ]),
  // 严格档：管理/通话控制等低频且代价高的动作
  strict: new Set([
    'admin_kick', 'admin_mute', 'admin_unban', 'admin_botban', 'admin_users', 'admin_audit',
    'admin_login', 'admin_invites', 'admin_applications', 'admin_approve', 'admin_reject',
    'lifecycle_sweep', 'room_history_clear', 'history_clear',
    'call_user', 'call_accept', 'call_reject', 'call_end',
    'group_create', 'ss_start', 'share_register'
  ])
};
// 每窗口允许的事件数；窗口毫秒
const LIMITS = { normal: 40, strict: 12, windowMs: 1000 };

// 返回一个可挂到 io.on('connection') 里 socket.use((pkt,next)=>...) 的中间件
function socketRateLimiter() {
  // event -> 时间戳数组（挂在闭包，随连接一起回收）
  const hits = new Map();
  return function rateLimitMiddleware(packet, next) {
    const evt = Array.isArray(packet) ? packet[0] : packet && packet[0];
    if (!evt || SOCKET_TIER.exempt.has(evt)) return next();
    const strict = SOCKET_TIER.strict.has(evt);
    const limit = strict ? LIMITS.strict : LIMITS.normal;
    const now = Date.now();
    let arr = hits.get(evt);
    if (!arr) { arr = []; hits.set(evt, arr); }
    while (arr.length && now - arr[0] > LIMITS.windowMs) arr.shift();
    if (arr.length >= limit) {
      // 超窗：静默丢弃（不 next()），避免异常客户端刷 CPU/广播/落库
      return;
    }
    arr.push(now);
    return next();
  };
}

module.exports = { securityHeaders, installProcessGuards, socketRateLimiter, CSP };

