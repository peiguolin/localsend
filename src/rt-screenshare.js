/* 屏幕共享（1 名共享者 → 多名观看者，WebRTC Mesh）：信令转发，媒体流 P2P 直连不经过服务器 */
const state = require('./state');
const { SS_MAX_VIEWERS } = require('./config');

let io = null;

function endScreenShare(reason) {
  if (!state.screenShare) return;
  const presenterId = state.screenShare.presenterId;
  state.screenShare = null;
  io.emit('ss_ended', { reason, presenterId });
}

// welcome 时下发给新连接的当前共享状态
function ssState() {
  return state.screenShare
    ? { active: true, presenterId: state.screenShare.presenterId, presenterName: state.screenShare.presenterName }
    : { active: false };
}

function register(ioRef, socket) {
  io = ioRef;
  const ss = () => state.screenShare;

  // 开始共享（全站同时只允许一名共享者）
  socket.on('ss_start', (data, cb) => {
    // 兼容 emit(event, ack) 与 emit(event, data, ack) 两种调用
    if (typeof data === 'function') { cb = data; }
    cb = typeof cb === 'function' ? cb : () => {};
    if (ss()) {
      return cb({ ok: false, error: `${ss().presenterName} 正在共享屏幕` });
    }
    state.screenShare = {
      presenterId: socket.id,
      presenterName: socket.data.nickname,
      startedAt: Date.now(),
      viewers: new Set()
    };
    io.emit('ss_started', { presenterId: socket.id, presenterName: socket.data.nickname });
    io.emit('system_message', {
      type: 'screen', nickname: socket.data.nickname,
      text: `${socket.data.nickname} 开始了屏幕共享`,
      timestamp: Date.now()
    });
    cb({ ok: true });
  });

  // 停止共享（仅共享者本人）
  socket.on('ss_stop', () => {
    if (ss() && ss().presenterId === socket.id) {
      io.emit('system_message', {
        type: 'screen', nickname: socket.data.nickname,
        text: `${socket.data.nickname} 结束了屏幕共享`,
        timestamp: Date.now()
      });
      endScreenShare('stop');
    }
  });

  // 观看共享
  socket.on('ss_watch', (data, cb) => {
    if (typeof data === 'function') { cb = data; }
    cb = typeof cb === 'function' ? cb : () => {};
    if (!ss()) return cb({ ok: false, error: '当前没有人共享屏幕' });
    if (ss().presenterId === socket.id) return cb({ ok: false, error: '你是共享者，无需观看' });
    if (ss().viewers.has(socket.id)) {
      // 幂等：重复观看直接成功（不重复通知共享者）
      return cb({ ok: true, presenterId: ss().presenterId, presenterName: ss().presenterName });
    }
    if (ss().viewers.size >= SS_MAX_VIEWERS) return cb({ ok: false, error: '观看人数已满' });
    ss().viewers.add(socket.id);
    const presenter = io.sockets.sockets.get(ss().presenterId);
    if (presenter) presenter.emit('ss_viewer_joined', { viewerId: socket.id, viewerName: socket.data.nickname });
    cb({ ok: true, presenterId: ss().presenterId, presenterName: ss().presenterName });
  });

  // 退出观看
  socket.on('ss_unwatch', () => {
    if (ss() && ss().viewers.delete(socket.id)) {
      const presenter = io.sockets.sockets.get(ss().presenterId);
      if (presenter) presenter.emit('ss_viewer_left', { viewerId: socket.id });
    }
  });

  // SDP / ICE 转发（角色校验：offer 只能来自共享者，answer 只能发给共享者，ICE 仅限共享者-观看者对）
  socket.on('ss_offer', (data) => {
    if (!ss() || ss().presenterId !== socket.id) return;
    const toId = String((data && data.toId) || '');
    if (!ss().viewers.has(toId)) return;
    const target = io.sockets.sockets.get(toId);
    if (target && target.connected) target.emit('ss_offer', { fromId: socket.id, sdp: data && data.sdp });
  });
  socket.on('ss_answer', (data) => {
    if (!ss()) return;
    const toId = String((data && data.toId) || '');
    if (toId !== ss().presenterId || !ss().viewers.has(socket.id)) return;
    const target = io.sockets.sockets.get(toId);
    if (target && target.connected) target.emit('ss_answer', { fromId: socket.id, sdp: data && data.sdp });
  });
  socket.on('ss_ice', (data) => {
    if (!ss()) return;
    const toId = String((data && data.toId) || '');
    const isPair = (socket.id === ss().presenterId && ss().viewers.has(toId)) ||
                   (toId === ss().presenterId && ss().viewers.has(socket.id));
    if (!isPair) return;
    const target = io.sockets.sockets.get(toId);
    if (target && target.connected) target.emit('ss_ice', { fromId: socket.id, candidate: data && data.candidate });
  });
}

// 断线清理：共享者离线 → 全员结束；观看者离线 → 通知共享者
function onDisconnect(ioRef, socket) {
  io = ioRef;
  if (!state.screenShare) return;
  if (state.screenShare.presenterId === socket.id) {
    io.emit('system_message', {
      type: 'screen', nickname: socket.data.nickname,
      text: `${socket.data.nickname} 的屏幕共享已结束`,
      timestamp: Date.now()
    });
    endScreenShare('offline');
  } else if (state.screenShare.viewers.delete(socket.id)) {
    const presenter = io.sockets.sockets.get(state.screenShare.presenterId);
    if (presenter) presenter.emit('ss_viewer_left', { viewerId: socket.id });
  }
}

module.exports = { register, onDisconnect, ssState };
