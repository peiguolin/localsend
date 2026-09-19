/* 入口：装配 HTTP/HTTPS、静态资源、各域路由与 Socket 模块，启动监听
 * 业务实现位于 src/ 各模块：
 *   config / util / state / certs / filemeta / chatlog     —— 基础层
 *   routes-files                                           —— 上传/下载/预览/导出
 *   rt-share / rt-rooms / rt-chat / rt-call / rt-whiteboard / rt-screenshare —— 实时域
 */
const path = require('path');
const express = require('express');
const https = require('https');
const { Server } = require('socket.io');

const { PORT, ROOT_DIR, MAX_FILE_SIZE, currentConfig } = require('./src/config');
const { loadCredentials } = require('./src/certs');
const state = require('./src/state');
const store = require('./db.js');
const { randomNickname, isLocalSocket, broadcastMembers, getLanIPs } = require('./src/util');
const { decorateHistory } = require('./src/filemeta');
const { decorateWithReactions } = require('./src/rt-reactions');

const routesFiles = require('./src/routes-files');
const rtShare = require('./src/rt-share');
const rtRooms = require('./src/rt-rooms');
const rtChat = require('./src/rt-chat');
const rtCall = require('./src/rt-call');
const rtWhiteboard = require('./src/rt-whiteboard');
const rtScreenshare = require('./src/rt-screenshare');
const rtCalendar = require('./src/rt-calendar');
const rtTranslate = require('./src/rt-translate');
const rtConfig = require('./src/rt-config');
const rtBot = require('./src/rt-bot');
const rtAdmin = require('./src/rt-admin');
const rtPin = require('./src/rt-pin');
const rtReactions = require('./src/rt-reactions');
const rtRead = require('./src/rt-read');
const auth = require('./src/auth');
const routesAuth = require('./src/routes-auth');

const app = express();
const server = https.createServer(loadCredentials(), app);
const io = new Server(server);

// TURN/STUN 服务器（配置中心 turnServers，JSON 数组字符串）：welcome 下发给客户端 WebRTC 用
function parseIceServers() {
  try {
    const raw = currentConfig().turnServers;
    if (!raw) return [];
    const arr = JSON.parse(String(raw));
    if (!Array.isArray(arr)) return [];
    return arr.filter((s) => s && typeof s === 'object' && s.urls);
  } catch (_) { return []; }
}

// 安全响应头 + CSP（在所有路由/静态资源之前）
const { securityHeaders, installProcessGuards, socketRateLimiter } = require('./src/guard');
app.use(securityHeaders);

// ---------- 静态资源 ----------
app.use(express.static(path.join(ROOT_DIR, 'public')));

// ---------- 公网邀请模式门禁（'off' 时完全旁路） ----------
// 登录/申请/状态/join 页放行；其余 /api、/images、/download、/upload、/data-export 一律要求有效会话
app.use(auth.authMiddleware);

// ---------- HTTP 路由（公网认证 + 文件/文件夹共享中转 + 日历数据 + 翻译 + 配置中心） ----------
routesAuth.registerRoutes(app);
routesFiles.registerRoutes(app, io);
rtShare.registerRoutes(app, io);
rtCalendar.registerRoutes(app);
rtTranslate.registerRoutes(app);
rtConfig.registerRoutes(app);

// ---------- Socket.IO 连接编排 ----------
io.on('connection', (socket) => {
  // 按连接的事件频率闸（丢弃超限包；白板笔迹/光标/ICE 等高频流豁免）
  socket.use(socketRateLimiter());

  socket.data.lastRenameAt = 0;
  socket.data.lastCursorRelay = 0;
  // 公网邀请模式：远端连接必须带有效会话 token（身份由服务端签发）；
  // 宿主机直连（未过反代）按 LAN 匿名处理，用于引导创建首个邀请码/审批/本机管理。
  let clientId = '';
  if (auth.inviteEnabled()) {
    if (auth.isDirectLocalSocket(socket)) {
      socket.data.nickname = randomNickname();
      clientId = String((socket.handshake.auth && socket.handshake.auth.clientId) || '');
      socket.data.clientId = clientId;
      socket.data.localHost = true;
    } else {
      const token = String((socket.handshake.auth && socket.handshake.auth.sessionToken) || '');
      const session = auth.validateSession(token);
      if (!session) {
        // 预认证态：只注册管理员登录事件（其余事件一律被 rt-admin 拒绝），不加入房间、不广播
        socket.data.preAuth = true;
        socket.emit('auth_required', { error: '未登录或会话已过期，请先登录' });
        rtAdmin.register(io, socket);
        return;
      }
      clientId = session.userId;
      socket.data.clientId = clientId;
      socket.data.nickname = session.nickname || session.username;
      socket.data.role = session.role || 'user';
      socket.data.session = session;
      try { store.touchUser(clientId, auth.socketIp(socket)); } catch (_) { /* 非关键 */ }
    }
  } else {
    socket.data.nickname = randomNickname();
    // 持久身份（握手带来）：用于群聊成员身份与房间恢复
    clientId = String((socket.handshake.auth && socket.handshake.auth.clientId) || '');
    socket.data.clientId = clientId;
  }
  // 封禁校验：被剔除的 clientId / 账号直接断开，不允许进入聊天室
  if (clientId && state.bans.has(clientId)) {
    socket.emit('system_message', { text: '你已被移出聊天室，无法重新加入' });
    socket.disconnect(true);
    return;
  }
  // 始终加入公共房
  socket.join('main');
  state.onlineUsers.set(socket.id, socket.data.nickname);
  state.cursorColors.set(socket.id, rtWhiteboard.assignCursorColor());

  // 恢复该 client 加入过的群聊房（房间持久化）：加入对应 Socket.IO room 并在线
  const myRooms = [];
  if (clientId) {
    const ids = state.clientRooms.get(clientId) || new Set();
    for (const rid of ids) {
      const room = state.groupRooms.get(rid);
      if (!room) continue;
      socket.join(rid);
      if (!room.online) room.online = new Set();
      room.online.add(socket.id);
      myRooms.push(rtRooms.publicRoomInfo(room));
    }
  }

  // 扫码/链接加入：握手带 inviteToken，命中群聊房则自动成为成员（持久化）+ 入房
  const joinToken = String((socket.handshake.auth && socket.handshake.auth.joinToken) || '');
  if (joinToken) {
    let target = null;
    for (const room of state.groupRooms.values()) {
      if (room.inviteToken === joinToken) { target = room; break; }
    }
    if (target) {
      if (clientId && !target.members.some((m) => m.clientId === clientId)) {
        target.members.push({ clientId, nickname: socket.data.nickname });
        store.updateRoom(target);
        if (!state.clientRooms.has(clientId)) state.clientRooms.set(clientId, new Set());
        state.clientRooms.get(clientId).add(target.id);
      }
      socket.join(target.id);
      if (!target.online) target.online = new Set();
      target.online.add(socket.id);
      if (!myRooms.some((r) => r.id === target.id)) myRooms.push(rtRooms.publicRoomInfo(target));
      io.to(target.id).emit('system_message', {
        type: 'group', room: target.id, nickname: socket.data.nickname,
        text: `${socket.data.nickname} 通过邀请链接加入了群聊「${target.name}」`,
        timestamp: Date.now()
      });
    }
  }

  // 通知本人（id 用于 WebRTC 通话信令定位）；附带最近历史消息 + 我加入的群聊房
  let history = [];
  let announcement = null;
  let pins = [];
  try {
    history = rtRead.decorateWithReads(decorateWithReactions(decorateHistory(store.loadMessages(200, 'main')), socket.data.clientId));
    announcement = store.getAnnouncement('main');
    pins = rtPin.loadRoomPins('main');
  } catch (_) { /* 历史不可用 */ }
  socket.emit('welcome', {
    id: socket.id, nickname: socket.data.nickname, clientId: socket.data.clientId, online: state.onlineUsers.size,
    history, rooms: myRooms, isLocal: isLocalSocket(socket),
    announcement, pins,
    iceServers: parseIceServers()
  });
  // 推送当前共享列表与屏幕共享状态
  socket.emit('shares_update', Array.from(state.shares.values()).map(rtShare.publicShareInfo));
  socket.emit('ss_state', rtScreenshare.ssState());

  // 广播上线
  io.emit('system_message', {
    type: 'join',
    nickname: socket.data.nickname,
    text: `${socket.data.nickname} 加入了聊天室`,
    timestamp: Date.now()
  });
  broadcastMembers(io);

  // 各实时域注册事件
  rtChat.register(io, socket);
  rtBot.register(io, socket); // 需在 rtChat 之后：机器人触发依赖消息已入库/入流水
  rtRooms.register(io, socket);
  rtPin.register(io, socket);
  rtReactions.register(io, socket);
  rtRead.register(io, socket);
  rtCall.register(io, socket);
  rtWhiteboard.register(io, socket);
  rtScreenshare.register(io, socket);
  rtShare.register(io, socket);
  rtCalendar.register(io, socket);
  rtAdmin.register(io, socket);

  // 断线：按域清理（注意顺序：通话清理需要 onlineUsers 里的昵称，先清域再删在线表）
  socket.on('disconnect', () => {
    rtRooms.onDisconnect(io, socket);
    rtCall.onDisconnect(io, socket);
    rtScreenshare.onDisconnect(io, socket);
    state.onlineUsers.delete(socket.id);
    rtWhiteboard.onDisconnect(io, socket);
    rtShare.onDisconnect(io, socket);
    io.emit('system_message', {
      type: 'leave',
      nickname: socket.data.nickname,
      text: `${socket.data.nickname} 离开了聊天室`,
      timestamp: Date.now()
    });
    broadcastMembers(io);
  });
});

// 数据持久化：启动时自动建库（data/chat.db），失败不阻塞服务
try {
  store.init();
  console.log('  数据持久化: 已连接 SQLite (' + store.DB_FILE + ')');
} catch (e) {
  console.warn('  数据持久化: SQLite 初始化失败，历史功能不可用 —', e.message);
}

// 数据生命周期：文件 TTL / 容量上限 / 孤儿 / 消息保留，定期自动清扫
const lifecycle = require('./src/lifecycle');
lifecycle.startScheduler();

// 日历日程提醒：到点向对应房间推送系统消息（需 DB 就绪；timer 供优雅退出时清除）
const reminderTimer = rtCalendar.startReminder(io);
{
  const rc = lifecycle.retentionConfig();
  console.log(`  生命周期:   文件保留 ${rc.fileTtlDays > 0 ? rc.fileTtlDays + ' 天' : '不限'} · 容量上限 ${rc.maxUploadMB > 0 ? rc.maxUploadMB + 'MB' : '不限'} · 消息保留 ${rc.msgTtlDays > 0 ? rc.msgTtlDays + ' 天' : '永久'} · 每 ${rc.sweepIntervalMin} 分钟清扫`);
  // 磁盘水位告警：uploads 容量或所在分区接近满时启动即提示
  const disk = lifecycle.diskUsage();
  const warns = [];
  if (disk.quotaPct >= 80) warns.push(`uploads 容量已用 ${disk.quotaPct}%`);
  if (disk.fsPct >= 80) warns.push(`磁盘分区已用 ${disk.fsPct}%`);
  if (warns.length) {
    console.warn(`  ⚠ 磁盘水位告警：${warns.join('；')}。请及时清理（数据面板可「立即清理」）或扩容。`);
  }
}

// 恢复持久化的群聊房间（成员按 clientId 记录，重启后重新加入的在线成员自动归位）
try {
  rtRooms.loadGroupRoomsFromDb();
  if (state.groupRooms.size > 0) console.log(`  群聊房间: 已恢复 ${state.groupRooms.size} 个群聊`);
} catch (e) {
  console.warn('  群聊房间: 恢复失败 —', e.message);
}

// 恢复持久化的用户管理状态（剔除/禁言/禁机器人）与房间级机器人覆盖
rtAdmin.loadUserAdminFromDb();
rtBot.loadRoomBotFromDb();

// 公网邀请模式：恢复被封禁账号（users.banned=1 -> 封禁表，跨重启持续封禁）
if (auth.inviteEnabled()) {
  auth.loadBannedUsersFromDb();
  console.log(`  公网模式:   邀请制已开启（登录 + 审批 + IP 审计）${auth.remoteAdminEnabled() ? '，远程管理口令已配置' : '，远程管理口令未配置（仅宿主机可管理）'}`);
}

// 翻译引擎探测（自动发现本机 LibreTranslate）完成后再对外服务
rtTranslate.detectEngine().finally(() => {
server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  局域网聊天 + 文件传输 + 文件夹共享 已启动');
  console.log('==========================================');
  const ips = getLanIPs();
  if (ips.length > 0) {
    for (const ip of ips) {
      console.log(`  局域网访问: https://${ip.address}:${PORT}`);
    }
  } else {
    console.log(`  未检测到局域网 IP，请使用 https://127.0.0.1:${PORT} 本机访问`);
  }
  console.log(`  本机访问:   https://127.0.0.1:${PORT}`);
  console.log('  首次访问:   自签名证书，浏览器点「高级 → 继续访问」即可');
  const fileLimitMb = Math.round(MAX_FILE_SIZE / 1024 / 1024);
  console.log(`  上传限制:   单文件最大 ${fileLimitMb >= 1024 && fileLimitMb % 1024 === 0 ? `${fileLimitMb / 1024}GB` : `${fileLimitMb}MB`}`);
  console.log('  文件夹共享: 共享他人文件夹需使用 Chrome / Edge 浏览器');
  console.log('  按 Ctrl+C 停止服务');
  console.log('==========================================');
});
});

// ---------- 优雅退出（SIGINT/SIGTERM）：停止定时器、通知客户端、清理共享传输与 .tmp、关 SQLite ----------
const { TMP_DIR } = require('./src/config');
const fs = require('fs');

function shutdown(signal) {
  console.log(`\n  收到 ${signal}，正在优雅退出…`);
  try { lifecycle.stopScheduler(); } catch (_) { /* 忽略 */ }
  if (reminderTimer) { try { clearInterval(reminderTimer); } catch (_) { /* 忽略 */ } }

  // 告知在线客户端正在关闭（页面提示而非"已断开"）
  try { io.emit('system_message', { text: '服务器正在关闭，请稍后重试' }); } catch (_) { /* 忽略 */ }

  // 清理挂起的文件夹共享传输（共享者/下载者/上传者请求直接结束）
  for (const [, t] of state.pendingTransfers) {
    try {
      clearTimeout(t.timer);
      if (t.res && !t.res.headersSent) t.res.status(503).json({ ok: false, error: '服务器正在关闭' });
      else if (t.res) t.res.destroy();
      if (t.req && !t.req.readableEnded) t.req.destroy();
    } catch (_) { /* 忽略 */ }
  }
  try { state.pendingTransfers.clear(); } catch (_) { /* 忽略 */ }

  // 清理断点续传暂存区（下次启动本就会清，这里提前收尾）
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  // 停止接收新连接；存量请求结束后关库退出。限时 5s 兜底强制退出
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    try { store.close(); } catch (_) { /* 忽略 */ }
    process.exit(0);
  };
  try {
    server.close(finish);
    // 有长连接（WebSocket/大文件传输）时 server.close 可能等不到，兜底强制
    setTimeout(finish, 5000).unref();
  } catch (_) {
    finish();
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// 进程级错误兜底：未捕获 rejection 仅记录；未捕获同步异常记录后走优雅退出
installProcessGuards((reason) => shutdown(reason || 'fatal'));
