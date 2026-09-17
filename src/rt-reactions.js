/* 消息表情回应：实时广播 + SQLite 持久化（同人同消息同表情唯一 = 点一下加、再点取消）。
 * 事件：
 *   message_reaction (client → server): { room, msgId, emoji }
 *   message_reaction (server → room):   { room, msgId, action: 'add'|'remove', clientId, nickname, emoji, reactions }
 *   其中 reactions 为该消息当前聚合结果 [{emoji, count, names, mine}]（mine 按请求者 clientId 计算）
 */
const store = require('../db.js');
const state = require('./state');
const { chatLogFind } = require('./chatlog');

const { groupRooms } = state;

// 房间成员校验（与 rt-rooms.canSendToRoom 同规则；本地复制避免环依赖）
function canSendToRoom(roomId, clientId) {
  if (roomId === 'main') return true;
  const gr = groupRooms.get(roomId);
  return !!gr && !!clientId && gr.members.some((m) => m.clientId === clientId);
}

let io = null;

// 表情白名单：非空、无控制字符、长度 ≤ 12（组合 emoji 允许多字符），排除空白
const EMOJI_RE = /^[^\s\p{Cc}\p{Cf}]{1,12}$/u;

// 给一批消息附加 reactions 聚合（room_history / 搜索 / 分页 / welcome 共用）
// msgs: decorateHistory 后的消息数组；myClientId 用于标记 mine
function decorateWithReactions(msgs, myClientId) {
  if (!Array.isArray(msgs) || !msgs.length) return msgs;
  const me = String(myClientId || '');
  // 按房间分组查询（一次 SQL 拿全）
  const byRoom = new Map();
  for (const m of msgs) {
    const room = String((m && m.room) || 'main');
    if (!byRoom.has(room)) byRoom.set(room, []);
    byRoom.get(room).push(m);
  }
  for (const [room, list] of byRoom) {
    const rows = store.loadReactionsForMessages(room, list.map((m) => m.id));
    const aggById = new Map(rows.map((r) => [String(r.msgId), r.reactions]));
    for (const m of list) {
      const agg = aggById.get(String(m.id)) || [];
      m.reactions = agg.map((r) => ({ emoji: r.emoji, count: r.count, names: r.names || [], mine: (r.clientIds || []).includes(me) }));
    }
  }
  return msgs;
}

// 单条消息的聚合（广播与返回前端用）；mine 按请求者 clientId 计算
function aggregateForMessage(room, msgId, myClientId) {
  const me = String(myClientId || '');
  const rows = store.loadReactionsForMessages(room, [msgId]);
  const agg = (rows[0] && rows[0].reactions) || [];
  return agg.map((r) => ({ ...r, mine: (r.clientIds || []).includes(me) }));
}

function register(ioRef, socket) {
  io = ioRef;

  // 点表情/取消表情（toggle）
  socket.on('message_reaction', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    const msgId = String((data && data.msgId) || '');
    const emoji = String((data && data.emoji) || '');
    if (!msgId || !emoji || !EMOJI_RE.test(emoji)) return cb({ ok: false, error: '参数无效' });
    if (room !== 'main' && !canSendToRoom(room, socket.data.clientId)) {
      return cb({ ok: false, error: '你不在该房间中' });
    }
    // 消息必须存在（内存流水或 DB）
    let msg = chatLogFind(msgId);
    if (!msg) msg = store.getMessageById(msgId);
    if (!msg || msg.recalled || String(msg.room || 'main') !== room) {
      return cb({ ok: false, error: '消息不存在' });
    }
    const clientId = String(socket.data.clientId || socket.id);
    const existed = store.addReaction(room, msgId, clientId, socket.data.nickname, emoji);
    const action = existed ? 'add' : 'remove';
    if (!existed) store.removeReaction(room, msgId, clientId, emoji);
    const reactions = aggregateForMessage(room, msgId, clientId);
    io.to(room).emit('message_reaction', {
      room, msgId, action, clientId, nickname: socket.data.nickname, emoji, reactions
    });
    cb({ ok: true, action, reactions });
  });
}

module.exports = { register, decorateWithReactions, aggregateForMessage };
