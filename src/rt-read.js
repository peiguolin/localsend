/* 已读回执：会话级内存记录"谁读到了哪条消息"。
 * 事件：
 *   read_messages (client → server): { room, upToTs }  —— 我在此时间点之前（含）的消息都已读
 *   messages_read (server → room):   { room, msgIds, clientId, nickname } —— 某人新读了这些消息
 * 说明：已读状态按消息存内存（重启即清零），不做 DB 持久化——"谁在线看过"属于会话性信息。
 * msgId 全站唯一（chatlog.nextMsgId），可直接作为 key。
 */
const state = require('./state');
const { chatLog } = require('./chatlog');

const { groupRooms } = state;

// 房间成员校验（与 rt-rooms.canSendToRoom 同规则；本地复制避免环依赖）
function canSendToRoom(roomId, clientId) {
  if (roomId === 'main') return true;
  const gr = groupRooms.get(roomId);
  return !!gr && !!clientId && gr.members.some((m) => m.clientId === clientId);
}

let io = null;

// msgId -> Map<clientId, nickname>
const readersByMsg = new Map();

function getReaders(msgId) {
  let s = readersByMsg.get(msgId);
  if (!s) { s = new Map(); readersByMsg.set(msgId, s); }
  return s;
}

// 给一批消息附加已读信息（history 装饰：readCount + readBy 读者昵称列表）
function decorateWithReads(msgs) {
  if (!Array.isArray(msgs)) return msgs;
  for (const m of msgs) {
    if (!m || !m.id) continue;
    const readers = readersByMsg.get(String(m.id));
    if (readers && readers.size) {
      m.readCount = readers.size;
      m.readBy = Array.from(readers.entries()).slice(0, 20).map(([clientId, nickname]) => ({ clientId, nickname }));
    }
  }
  return msgs;
}

function register(ioRef, socket) {
  io = ioRef;

  socket.on('read_messages', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    const upToTs = Number((data && data.upToTs) || 0);
    if (!upToTs) return cb({ ok: false, error: '缺少时间点' });
    if (room !== 'main' && !canSendToRoom(room, socket.data.clientId)) {
      return cb({ ok: false, error: '你不在该房间中' });
    }
    const clientId = String(socket.data.clientId || socket.id);
    const nickname = socket.data.nickname;
    const affected = [];
    // 遍历内存消息流水（封顶 CHAT_LOG_MAX 条）：时间 ≤ upToTs 且非本人 → 记已读
    for (const msg of chatLog) {
      if (!msg || String(msg.room || 'main') !== room) continue;
      if (msg.recalled) continue;
      if (!(msg.timestamp && msg.timestamp <= upToTs)) continue;
      if (msg.clientId === clientId) continue;
      const readers = getReaders(String(msg.id));
      if (!readers.has(clientId)) {
        readers.set(clientId, nickname);
        affected.push(String(msg.id));
      }
    }
    if (affected.length) {
      io.to(room).emit('messages_read', { room, msgIds: affected, clientId, nickname, upToTs });
    }
    cb({ ok: true, count: affected.length });
  });
}

module.exports = { register, decorateWithReads };
