/* 群聊房间：房间注册表、DB 持久化加载、Socket 事件（创建/历史/退出/重命名/清空） */
const crypto = require('crypto');
const store = require('../db.js');
const state = require('./state');
const { decorateHistory } = require('./filemeta');
const { purgeChatLog } = require('./chatlog');
const { isLocalSocket } = require('./util');

// ============================================================
//  群聊房间（自定义房间，独立 room 号，消息按房间路由）
//  公共房 room='main'（所有人在）；群聊房 room='g<随机>'（创建者+被拉成员）
//  成员身份用持久 clientId（DB 存储）；在线集合用 socketId（Socket.IO room 广播）
// ============================================================
const { groupRooms, clientRooms, onlineUsers } = state;

let io = null;

function loadGroupRoomsFromDb() {
  try {
    const rooms = store.loadRooms();
    groupRooms.clear();
    clientRooms.clear();
    for (const r of rooms) {
      groupRooms.set(r.id, r);
      for (const m of r.members) {
        if (!clientRooms.has(m.clientId)) clientRooms.set(m.clientId, new Set());
        clientRooms.get(m.clientId).add(r.id);
      }
    }
  } catch (e) {
    console.warn('群聊房间加载失败:', e.message);
  }
}

// 房间公开信息（发给成员的）
function publicRoomInfo(room) {
  return {
    id: room.id,
    name: room.name,
    ownerClientId: room.ownerClientId,
    ownerNick: room.ownerNick,
    members: room.members,
    createdAt: room.createdAt
  };
}

// 通知某个 clientId 对应的在线 socket（可能多开）
function emitToClient(clientId, event, data) {
  for (const s of io.sockets.sockets.values()) {
    if (s.handshake.auth && s.handshake.auth.clientId === clientId) {
      s.emit(event, data);
    }
  }
}

// 新房间自动命名：取前 2 个非创建者昵称
function autoRoomName(room) {
  const others = room.members.filter((m) => m.clientId !== room.ownerClientId).map((m) => m.nickname);
  const shown = others.slice(0, 2);
  let name = shown.length ? shown.join('、') : '我的群聊';
  if (others.length > 2) name += ` 等 ${room.members.length} 人`;
  return name;
}

// 校验某 client 是否可向该房间发消息（main 公共房所有人可；群聊房需是成员）
function canSendToRoom(roomId, clientId) {
  if (roomId === 'main') return true;
  const gr = groupRooms.get(roomId);
  return !!gr && !!clientId && gr.members.some((m) => m.clientId === clientId);
}

function register(ioRef, socket) {
  io = ioRef;

  // 创建群聊：从在线成员多选拉起；目标成员自动加入（出现在其房间列表）
  socket.on('group_create', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const targets = Array.isArray(data && data.targetIds) ? data.targetIds : [];
    if (!targets.length) return cb({ ok: false, error: '请至少选择一位成员' });
    if (!socket.data.clientId) return cb({ ok: false, error: '身份标识缺失，请刷新页面重试' });

    // 收集目标成员（在线且非自己），去重
    const memberMap = new Map(); // clientId -> { clientId, nickname }
    memberMap.set(socket.data.clientId, { clientId: socket.data.clientId, nickname: socket.data.nickname });
    const targetSockets = [];
    for (const tid of targets) {
      const targetSocket = io.sockets.sockets.get(String(tid));
      if (!targetSocket || targetSocket.id === socket.id) continue;
      const tClientId = String((targetSocket.handshake.auth && targetSocket.handshake.auth.clientId) || '');
      if (!tClientId || memberMap.has(tClientId)) continue;
      memberMap.set(tClientId, { clientId: tClientId, nickname: onlineUsers.get(targetSocket.id) || '未知' });
      targetSockets.push(targetSocket);
    }
    if (memberMap.size < 2) return cb({ ok: false, error: '需要至少一位其他成员' });

    // 生成独立房间号
    let roomId = '';
    do { roomId = 'g' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
    while (groupRooms.has(roomId));

    const members = Array.from(memberMap.values());
    const room = {
      id: roomId,
      name: '',
      ownerClientId: socket.data.clientId,
      ownerNick: socket.data.nickname,
      members,
      createdAt: Date.now()
    };
    room.name = String((data && data.name) || '').trim().slice(0, 30) || autoRoomName(room);

    groupRooms.set(roomId, room);
    store.createRoom(room);
    // 维护 clientRooms 索引
    for (const m of members) {
      if (!clientRooms.has(m.clientId)) clientRooms.set(m.clientId, new Set());
      clientRooms.get(m.clientId).add(roomId);
    }

    // 创建者与所有目标加入 Socket.IO room
    socket.join(roomId);
    if (!room.online) room.online = new Set();
    room.online.add(socket.id);
    for (const ts of targetSockets) {
      ts.join(roomId);
      if (!room.online) room.online = new Set();
      room.online.add(ts.id);
    }

    const info = publicRoomInfo(room);
    // 通知创建者
    socket.emit('group_created', { ok: true, room: info });
    // 通知被拉的人（自动加入，出现在房间列表）
    for (const ts of targetSockets) {
      ts.emit('group_invited', { room: info });
    }
    // 群聊内系统提示
    io.to(roomId).emit('system_message', {
      type: 'group',
      room: roomId,
      nickname: socket.data.nickname,
      text: `${socket.data.nickname} 创建了群聊「${room.name}」`,
      timestamp: Date.now()
    });
    cb({ ok: true, room: info });
  });

  // 加载房间历史（切换房间时）
  socket.on('room_history', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    if (room !== 'main' && !canSendToRoom(room, socket.data.clientId)) {
      return cb({ ok: false, error: '你不在该房间中' });
    }
    try {
      const history = decorateHistory(store.loadMessages(200, room));
      cb({ ok: true, room, history });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 退出群聊（创建者退出即解散）
  socket.on('group_leave', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const roomId = String((data && data.room) || '');
    const gr = groupRooms.get(roomId);
    if (!gr) return cb({ ok: false, error: '房间不存在' });
    if (!socket.data.clientId || !gr.members.some((m) => m.clientId === socket.data.clientId)) {
      return cb({ ok: false, error: '你不是该房间成员' });
    }
    if (gr.ownerClientId === socket.data.clientId) {
      // 创建者退出 → 解散房间
      io.to(roomId).emit('system_message', {
        type: 'group', room: roomId, nickname: socket.data.nickname,
        text: `群聊「${gr.name}」已被创建者解散`, timestamp: Date.now()
      });
      for (const m of gr.members) {
        const set = clientRooms.get(m.clientId);
        if (set) { set.delete(roomId); if (!set.size) clientRooms.delete(m.clientId); }
      }
      groupRooms.delete(roomId);
      store.deleteRoom(roomId);
      // 让所有在线成员离开 socket room
      for (const s of io.sockets.sockets.values()) if (s.rooms && s.rooms.has(roomId)) s.leave(roomId);
      socket.emit('group_disbanded', { room: roomId });
      cb({ ok: true, disbanded: true });
      return;
    }
    // 普通成员退出：从成员列表移除 + 持久化 + 离开 socket room
    gr.members = gr.members.filter((m) => m.clientId !== socket.data.clientId);
    store.updateRoom(gr);
    const set = clientRooms.get(socket.data.clientId);
    if (set) { set.delete(roomId); if (!set.size) clientRooms.delete(socket.data.clientId); }
    socket.leave(roomId);
    socket.emit('group_left', { room: roomId });
    io.to(roomId).emit('system_message', {
      type: 'group', room: roomId, nickname: socket.data.nickname,
      text: `${socket.data.nickname} 退出了群聊`, timestamp: Date.now()
    });
    cb({ ok: true });
  });

  // 重命名群聊
  socket.on('group_rename', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const roomId = String((data && data.room) || '');
    const name = String((data && data.name) || '').trim().slice(0, 30);
    const gr = groupRooms.get(roomId);
    if (!gr) return cb({ ok: false, error: '房间不存在' });
    if (!socket.data.clientId || !gr.members.some((m) => m.clientId === socket.data.clientId)) {
      return cb({ ok: false, error: '你不是该房间成员' });
    }
    if (!name) return cb({ ok: false, error: '名称不能为空' });
    const old = gr.name;
    gr.name = name;
    store.updateRoom(gr);
    io.to(roomId).emit('system_message', {
      type: 'group', room: roomId, nickname: socket.data.nickname,
      text: `${socket.data.nickname} 将群聊「${old}」改名为「${name}」`, timestamp: Date.now()
    });
    cb({ ok: true, room: publicRoomInfo(gr) });
  });

  // 清空群聊房历史（房主 clientId 或宿主机）
  socket.on('room_history_clear', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const roomId = String((data && data.room) || '');
    const gr = groupRooms.get(roomId);
    if (!gr) return cb({ ok: false, error: '房间不存在' });
    const isOwner = !!(socket.data.clientId && socket.data.clientId === gr.ownerClientId);
    if (!isOwner && !isLocalSocket(socket)) {
      return cb({ ok: false, error: '仅房主或宿主机可清空本房间历史' });
    }
    try {
      const r = store.clearHistory(roomId, false);
      purgeChatLog(roomId);
      cb({ ok: true, ...r });
      io.to(roomId).emit('room_cleared', { room: roomId, nickname: socket.data.nickname, timestamp: Date.now() });
      io.to(roomId).emit('system_message', {
        type: 'group', room: roomId, nickname: socket.data.nickname,
        text: `${socket.data.nickname} 清空了本房间聊天记录`,
        timestamp: Date.now()
      });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

// 断线清理：从所有已加入房间的在线集合移除（房间与成员身份仍持久化保留）
function onDisconnect(ioRef, socket) {
  io = ioRef;
  for (const gr of groupRooms.values()) {
    if (gr.online && gr.online.delete(socket.id) && gr.online.size === 0) delete gr.online;
  }
}

module.exports = {
  register, onDisconnect,
  loadGroupRoomsFromDb, publicRoomInfo, canSendToRoom, emitToClient
};
