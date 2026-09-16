/* 置顶消息 + 群公告：房主/宿主机可置顶/取消置顶消息，设置/清除房间公告。
 * 置顶存 SQLite pinned 表，公告存 announcements 表（每房间一条），均跨重启持久。
 * 权限模型与「清空记录/机器人设置」一致：宿主机任意房间可，群聊房另加房主本人。
 * 事件：
 *   room_pin_add / room_pin_remove（广播 room_pinned / room_unpinned）
 *   room_announcement_set（广播 room_announcement）
 *   room_pins_get（查询，客户端进房时拉取）
 * 加载入口：loadRoomPins(room) 供 server.js(welcome) 与 rt-rooms(room_history) 复用。
 */
const store = require('../db.js');
const state = require('./state');
const { isLocalSocket } = require('./util');
const { decorateMsgUrls } = require('./filemeta');
const { chatLogFind } = require('./chatlog');

let io = null;

// 能否管理该房间的置顶/公告：宿主机任意房间；群聊房另加房主；main 公共房仅宿主机
function canManage(socket, roomId) {
  if (isLocalSocket(socket)) return true;
  if (roomId === 'main') return false;
  const gr = state.groupRooms.get(roomId);
  return !!(gr && gr.ownerClientId === socket.data.clientId);
}

// 取一条消息（内存流水优先，兜底 DB）；返回 null 表示不可用
function findMessage(msgId, room) {
  if (!msgId) return null;
  let msg = chatLogFind(msgId) || store.getMessageById(msgId);
  if (!msg || msg.recalled) return null;
  if ((msg.room || 'main') !== room) return null;
  return msg;
}

// 某房间的置顶列表（附带完整消息对象供渲染；失效的置顶自动清理）
function loadRoomPins(room) {
  const pins = [];
  for (const p of store.listPins(room || 'main')) {
    const msg = findMessage(p.msgId, room || 'main');
    if (!msg) {
      try { store.removePin(room || 'main', p.msgId); } catch (_) { /* 忽略 */ }
      continue;
    }
    pins.push({ msgId: p.msgId, pinnedAt: p.pinnedAt, pinner: p.pinner, msg: decorateMsgUrls(msg) });
  }
  return pins;
}

function register(ioRef, socket) {
  io = ioRef;

  // 置顶消息
  socket.on('room_pin_add', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    const msgId = String((data && data.msgId) || '');
    if (!canManage(socket, room)) return cb({ ok: false, error: '仅房主或宿主机可置顶消息' });
    const msg = findMessage(msgId, room);
    if (!msg) return cb({ ok: false, error: '消息不存在或已被撤回' });
    if (!store.addPin(room, msgId, socket.data.nickname || '宿主机')) {
      return cb({ ok: false, error: '该消息已在置顶中' });
    }
    io.to(room).emit('room_pinned', {
      room, msgId, pinnedAt: Date.now(), pinner: socket.data.nickname || '',
      msg: decorateMsgUrls(msg)
    });
    cb({ ok: true });
  });

  // 取消置顶
  socket.on('room_pin_remove', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    const msgId = String((data && data.msgId) || '');
    if (!canManage(socket, room)) return cb({ ok: false, error: '仅房主或宿主机可取消置顶' });
    if (!store.removePin(room, msgId)) return cb({ ok: false, error: '该消息未在置顶中' });
    io.to(room).emit('room_unpinned', { room, msgId });
    cb({ ok: true });
  });

  // 查询某房间置顶（客户端进房/欢迎时拉取；返回完整消息供渲染）
  socket.on('room_pins_get', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    if (room !== 'main' && !(socket.data.clientId && state.groupRooms.get(room) &&
        state.groupRooms.get(room).members.some((m) => m.clientId === socket.data.clientId))) {
      return cb({ ok: false, error: '你不在该房间中' });
    }
    try {
      cb({ ok: true, room, pins: loadRoomPins(room) });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 设置/清除群公告（空文本 = 清除）
  socket.on('room_announcement_set', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    if (!canManage(socket, room)) return cb({ ok: false, error: '仅房主或宿主机可设置公告' });
    const text = String((data && data.text) || '').trim().slice(0, 500);
    store.setAnnouncement(room, text, socket.data.nickname || '');
    const ann = { room, text, author: socket.data.nickname || '', updatedAt: Date.now() };
    io.to(room).emit('room_announcement', ann);
    cb({ ok: true, announcement: ann });
  });
}

module.exports = { register, canManage, loadRoomPins };
