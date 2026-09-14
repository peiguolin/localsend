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

const { PORT, ROOT_DIR } = require('./src/config');
const { loadCredentials } = require('./src/certs');
const state = require('./src/state');
const store = require('./db.js');
const { randomNickname, isLocalSocket, broadcastMembers, getLanIPs } = require('./src/util');
const { decorateHistory } = require('./src/filemeta');

const routesFiles = require('./src/routes-files');
const rtShare = require('./src/rt-share');
const rtRooms = require('./src/rt-rooms');
const rtChat = require('./src/rt-chat');
const rtCall = require('./src/rt-call');
const rtWhiteboard = require('./src/rt-whiteboard');
const rtScreenshare = require('./src/rt-screenshare');
const rtCalendar = require('./src/rt-calendar');
const rtTranslate = require('./src/rt-translate');

const app = express();
const server = https.createServer(loadCredentials(), app);
const io = new Server(server);

// ---------- 静态资源 ----------
app.use(express.static(path.join(ROOT_DIR, 'public')));

// ---------- HTTP 路由（文件 + 文件夹共享中转 + 日历数据 + 翻译） ----------
routesFiles.registerRoutes(app, io);
rtShare.registerRoutes(app, io);
rtCalendar.registerRoutes(app);
rtTranslate.registerRoutes(app);

// ---------- Socket.IO 连接编排 ----------
io.on('connection', (socket) => {
  socket.data.nickname = randomNickname();
  socket.data.lastRenameAt = 0;
  socket.data.lastCursorRelay = 0;
  // 持久身份（握手带来）：用于群聊成员身份与房间恢复
  const clientId = String((socket.handshake.auth && socket.handshake.auth.clientId) || '');
  socket.data.clientId = clientId;
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

  // 通知本人（id 用于 WebRTC 通话信令定位）；附带最近历史消息 + 我加入的群聊房
  let history = [];
  try { history = decorateHistory(store.loadMessages(200, 'main')); } catch (_) { /* 历史不可用 */ }
  socket.emit('welcome', { id: socket.id, nickname: socket.data.nickname, online: state.onlineUsers.size, history, rooms: myRooms, isLocal: isLocalSocket(socket) });
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
  rtRooms.register(io, socket);
  rtCall.register(io, socket);
  rtWhiteboard.register(io, socket);
  rtScreenshare.register(io, socket);
  rtShare.register(io, socket);
  rtCalendar.register(io, socket);

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

// 日历日程提醒：到点向对应房间推送系统消息（需 DB 就绪）
rtCalendar.startReminder(io);
{
  const rc = lifecycle.retentionConfig();
  console.log(`  生命周期:   文件保留 ${rc.fileTtlDays > 0 ? rc.fileTtlDays + ' 天' : '不限'} · 容量上限 ${rc.maxUploadMB > 0 ? rc.maxUploadMB + 'MB' : '不限'} · 消息保留 ${rc.msgTtlDays > 0 ? rc.msgTtlDays + ' 天' : '永久'} · 每 ${rc.sweepIntervalMin} 分钟清扫`);
}

// 恢复持久化的群聊房间（成员按 clientId 记录，重启后重新加入的在线成员自动归位）
try {
  rtRooms.loadGroupRoomsFromDb();
  if (state.groupRooms.size > 0) console.log(`  群聊房间: 已恢复 ${state.groupRooms.size} 个群聊`);
} catch (e) {
  console.warn('  群聊房间: 恢复失败 —', e.message);
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
  console.log('  上传限制:   单文件最大 200MB');
  console.log('  文件夹共享: 共享他人文件夹需使用 Chrome / Edge 浏览器');
  console.log('  按 Ctrl+C 停止服务');
  console.log('==========================================');
});
});
