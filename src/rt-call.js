/* 多方语音通话信令（WebRTC Mesh 房间模型） */
const crypto = require('crypto');
const state = require('./state');

// 1:1 是 targets=[1人] 的特例；身份一律以发送者 socket.id 为准，客户端无法伪造
const { callRooms, memberRooms, onlineUsers } = state;

let io = null;

function roomRoster(room) {
  return Array.from(room.members).map((id) => ({ id, nickname: onlineUsers.get(id) || '?' }));
}

// 广播给房间内所有已接通成员
function emitToRoom(room, event, payload) {
  for (const id of room.members) {
    const s = io.sockets.sockets.get(id);
    if (s && s.connected) s.emit(event, payload);
  }
}

// 成员离开房间（挂断/取消/离线），reason: 'hangup' | 'cancel' | 'offline'
function handleMemberLeave(socketId, reason) {
  const roomId = memberRooms.get(socketId);
  if (!roomId) return;
  const room = callRooms.get(roomId);
  if (!room) { memberRooms.delete(socketId); return; }
  const isOwner = room.ownerId === socketId;
  const hadRinging = room.ringing.size > 0;
  room.members.delete(socketId);
  room.ringing.delete(socketId);
  memberRooms.delete(socketId);
  const name = onlineUsers.get(socketId) || '?';
  // 通知剩余已接通成员
  for (const id of room.members) {
    const s = io.sockets.sockets.get(id);
    if (s && s.connected) s.emit('room_member_left', { roomId, memberId: socketId, memberName: name, reason });
  }
  // 发起者离开且还有人在振铃 → 全部取消
  if (isOwner && hadRinging) {
    for (const id of room.ringing) {
      const s = io.sockets.sockets.get(id);
      if (s && s.connected) s.emit('call_cancelled', { roomId });
      memberRooms.delete(id);
    }
    room.ringing.clear();
  }
  // 房间没人或只剩一人且无人振铃 → 解散，释放剩余成员的占用标记
  if (room.ringing.size === 0 && room.members.size <= 1) {
    for (const id of room.members) memberRooms.delete(id);
    callRooms.delete(roomId);
  }
}

function register(ioRef, socket) {
  io = ioRef;

  // 发起呼叫：targets 支持多个；逐个过滤在线/空闲；video 标志（视频通话）透传给被叫
  socket.on('call_user', (data) => {
    if (memberRooms.has(socket.id)) {
      return socket.emit('call_failed', { reason: 'busy', error: '你正在通话中' });
    }
    const video = data && data.video === true;
    const raw = Array.isArray(data && data.targets) ? data.targets : [];
    const targets = [];   // 可呼叫（在线且空闲）
    const busy = [];
    const offline = [];
    const seen = new Set();
    for (const t of raw) {
      const tid = String(t || '');
      if (!tid || tid === socket.id || seen.has(tid)) continue;
      seen.add(tid);
      if (!onlineUsers.has(tid)) { offline.push({ id: tid, nickname: tid }); continue; }
      if (memberRooms.has(tid)) { busy.push({ id: tid, nickname: onlineUsers.get(tid) }); continue; }
      targets.push({ id: tid, nickname: onlineUsers.get(tid) });
    }
    if (!targets.length) {
      const reason = (busy.length || offline.length) ? 'nobody' : 'empty';
      return socket.emit('call_failed', { reason, error: '没有可呼叫的成员（其余忙线或离线）', busy, offline });
    }
    const roomId = crypto.randomBytes(8).toString('hex');
    const room = { ownerId: socket.id, members: new Set([socket.id]), ringing: new Set(), video: video === true };
    for (const t of targets) room.ringing.add(t.id);
    callRooms.set(roomId, room);
    memberRooms.set(socket.id, roomId);
    for (const t of targets) memberRooms.set(t.id, roomId); // 振铃目标也标记为占用
    const roster = roomRoster(room);
    for (const t of targets) {
      const s = io.sockets.sockets.get(t.id);
      if (s && s.connected) s.emit('incoming_call', { roomId, fromId: socket.id, fromName: socket.data.nickname, targets, roster, video });
    }
    socket.emit('call_ringing', { roomId, targets, busy, offline, video });
  });

  // 接听：从振铃移入已接通，广播给全房间（含新人）以便建立 Mesh 连接
  socket.on('call_accept', (data) => {
    const roomId = String((data && data.roomId) || '');
    const room = callRooms.get(roomId);
    if (!room) return socket.emit('call_failed', { reason: 'gone', error: '通话已结束' });
    if (memberRooms.has(socket.id) && memberRooms.get(socket.id) !== roomId) {
      return socket.emit('call_failed', { reason: 'busy', error: '你正在其他通话中' });
    }
    if (!room.ringing.has(socket.id)) return;
    room.ringing.delete(socket.id);
    room.members.add(socket.id);
    memberRooms.set(socket.id, roomId);
    emitToRoom(room, 'room_member_joined', {
      roomId,
      member: { id: socket.id, nickname: socket.data.nickname },
      members: roomRoster(room)
    });
  });

  // 拒绝
  socket.on('call_reject', (data) => {
    const roomId = String((data && data.roomId) || '');
    const room = callRooms.get(roomId);
    if (!room) return;
    if (room.ringing.has(socket.id)) {
      room.ringing.delete(socket.id);
      memberRooms.delete(socket.id);
    }
    const owner = io.sockets.sockets.get(room.ownerId);
    if (owner && owner.connected) {
      owner.emit('call_rejected', { roomId, memberId: socket.id, memberName: socket.data.nickname });
    }
    if (room.members.size <= 1 && room.ringing.size === 0) {
      // 全部目标都拒绝 → 房间解散，通知发起者
      callRooms.delete(roomId);
      memberRooms.delete(room.ownerId);
      if (owner && owner.connected) {
        owner.emit('call_failed', { reason: 'all_rejected', error: '对方均未接听' });
      }
    }
  });

  // 挂断/取消（任一方随时可用）
  socket.on('call_end', (data) => {
    handleMemberLeave(socket.id, 'hangup');
  });

  // SDP / ICE 转发（校验收发双方在同一个房间，防跨房间注入）
  function relayRTC(evt, peerEvt) {
    socket.on(evt, (data) => {
      const toId = String((data && data.toId) || '');
      const roomId = String((data && data.roomId) || '');
      if (!toId || !roomId) return;
      if (memberRooms.get(socket.id) !== roomId || memberRooms.get(toId) !== roomId) return;
      const peer = io.sockets.sockets.get(toId);
      if (peer && peer.connected) {
        peer.emit(peerEvt, { fromId: socket.id, roomId, sdp: data && data.sdp, candidate: data && data.candidate });
      }
    });
  }
  relayRTC('rtc_offer', 'rtc_offer');
  relayRTC('rtc_answer', 'rtc_answer');
  relayRTC('rtc_ice', 'rtc_ice');
}

// 断线清理：通话中/振铃中离线 → 离开房间并通知他人
function onDisconnect(ioRef, socket) {
  io = ioRef;
  handleMemberLeave(socket.id, 'offline');
}

module.exports = { register, onDisconnect, handleMemberLeave };
