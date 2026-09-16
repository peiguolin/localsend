/* 聊天：消息收发/撤回/@提及/引用、昵称修改、数据面板（历史搜索/统计/清空） */
const store = require('../db.js');
const state = require('./state');
const { nextMsgId, chatLogPush, chatLogFind, purgeChatLog, quoteSnapshot, parseMentions } = require('./chatlog');
const { hasControlChars, isLocalSocket, broadcastMembers } = require('./util');
const { decorateHistory, deleteStoredFile } = require('./filemeta');
const lifecycle = require('./lifecycle');
const { myShareOf, broadcastShares } = require('./rt-share');
const { RECALL_WINDOW } = require('./config');
const { checkAllowed } = require('./moderation');

const { onlineUsers, groupRooms, wbStrokes } = state;

let io = null;

function register(ioRef, socket) {
  io = ioRef;

  // 聊天消息（带消息 ID/@提及解析/引用快照，入流水供撤回；按房间路由）
  socket.on('chat_message', (data) => {
    const text = String((data && data.text) || '').trim();
    if (!text || text.length > 5000) return;
    const room = String((data && data.room) || 'main');
    // 禁言 / 限流统一判定（与 HTTP 上传链路共用 src/moderation.js）
    const denied = checkAllowed(socket.data.clientId);
    if (denied) {
      socket.emit('system_message', { room, text: denied });
      return;
    }
    // 群聊房需校验成员身份；main 公共房所有人可发
    if (room !== 'main') {
      const gr = groupRooms.get(room);
      if (!gr || !socket.data.clientId || !gr.members.some((m) => m.clientId === socket.data.clientId)) return;
    }
    const msg = {
      id: nextMsgId(),
      type: 'text',
      room,
      senderId: socket.id,
      clientId: String((data && data.clientId) || ''),
      nickname: socket.data.nickname,
      text,
      mentions: parseMentions(text),
      timestamp: Date.now()
    };
    const quoteId = String((data && data.quoteId) || '');
    if (quoteId) {
      const q = quoteSnapshot(chatLogFind(quoteId));
      if (q) msg.quote = q;
    }
    chatLogPush(msg);
    store.insertMessage(msg);
    store.trimMessages(room);
    io.to(room).emit('chat_message', msg);
  });

  // 撤回消息（仅本人 + 2 分钟内，广播全员移除；内存/数据库联动）
  socket.on('chat_recall', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const id = String((data && data.id) || '');
    let msg = chatLogFind(id);
    // 内存流水里没有（可能是历史消息）→ 查数据库
    if (!msg) {
      msg = store.getMessageById(id);
    }
    if (!msg || msg.recalled) return cb({ ok: false, error: '消息不存在或已被撤回' });
    // 本人校验：优先持久 clientId（换昵称也能撤自己的历史消息），无则退回昵称
    const reqClientId = String((data && data.clientId) || '');
    const isOwner = reqClientId && msg.clientId ? reqClientId === msg.clientId : msg.nickname === socket.data.nickname;
    if (!isOwner) return cb({ ok: false, error: '只能撤回自己的消息' });
    if (Date.now() - msg.timestamp > RECALL_WINDOW) return cb({ ok: false, error: '超过 2 分钟，无法撤回' });
    msg.recalled = true;
    store.recallMessage(id);
    // 撤回联动删除文件本体与元数据（文件/图片消息）
    if (msg.storedName) {
      try { deleteStoredFile(msg.storedName); } catch (_) { /* 文件删除失败不阻塞撤回 */ }
    }
    const msgRoom = msg.room || 'main';
    io.to(msgRoom).emit('chat_recall', { id: msg.id, nickname: socket.data.nickname, clientId: msg.clientId || '', timestamp: Date.now() });
    cb({ ok: true });
  });

  // 修改昵称（全站唯一、1~20 字符、2 秒限速；silent 时不广播系统消息）
  socket.on('set_nickname', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const name = String((data && data.name) || '').trim();
    if (!name || name.length > 20) return cb({ ok: false, error: '昵称需为 1~20 个字符' });
    if (hasControlChars(name)) return cb({ ok: false, error: '昵称包含非法字符' });
    if (name === socket.data.nickname) return cb({ ok: true, nickname: name });
    const now = Date.now();
    if (now - socket.data.lastRenameAt < 2000) return cb({ ok: false, error: '修改太频繁，请稍后再试' });
    for (const [id, nick] of onlineUsers) {
      if (id !== socket.id && nick === name) return cb({ ok: false, error: '昵称已被他人使用' });
    }
    socket.data.lastRenameAt = now;
    const old = socket.data.nickname;
    socket.data.nickname = name;
    onlineUsers.set(socket.id, name);
    // 同步其共享的展示昵称
    const share = myShareOf(socket.id);
    if (share) {
      share.ownerNick = name;
      broadcastShares();
    }
    broadcastMembers(io);
    if (!data || !data.silent) {
      io.emit('system_message', {
        type: 'rename',
        nickname: name,
        text: `${old} 改名为 ${name}`,
        timestamp: Date.now()
      });
    }
    cb({ ok: true, nickname: name });
  });

  // ---------- 数据面板（历史/搜索/统计/清空） ----------

  // 搜索历史消息（关键词/昵称/时间范围）
  socket.on('history_search', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    try {
      const room = String((data && data.room) || 'main');
      if (room !== 'main' && !canSendToRoom(room, socket.data.clientId)) {
        return cb({ ok: false, error: '你不在该房间中，无法搜索' });
      }
      const results = store.searchMessages({
        keyword: String((data && data.keyword) || '').slice(0, 100) || null,
        nickname: String((data && data.nickname) || '').slice(0, 20) || null,
        from: data && data.from ? Number(data.from) : null,
        to: data && data.to ? Number(data.to) : null,
        room,
        limit: Math.min(Number((data && data.limit) || 100), 500)
      });
      cb({ ok: true, results: decorateHistory(results) });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 数据统计（含磁盘占用与保留策略）
  socket.on('history_stats', (cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    try {
      cb({ ok: true, ...store.stats('main'), disk: lifecycle.diskUsage(), retention: lifecycle.retentionConfig() });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 立即执行一次生命周期清扫（仅宿主机）
  socket.on('lifecycle_sweep', (cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (!isLocalSocket(socket)) return cb({ ok: false, error: '仅宿主机可执行清理' });
    try {
      const report = lifecycle.sweepAll();
      cb({ ok: true, report, disk: lifecycle.diskUsage() });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 清空公共房历史（仅宿主机；消息，可选连带白板）
  socket.on('history_clear', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (!isLocalSocket(socket)) return cb({ ok: false, error: '仅宿主机可清空公共房历史' });
    try {
      const r = store.clearHistory('main', !!(data && data.includeStrokes));
      purgeChatLog('main');
      if (data && data.includeStrokes) {
        wbStrokes.length = 0;
        state.wbTotalPoints = 0;
        io.emit('wb_clear', { author: socket.data.nickname });
      }
      cb({ ok: true, ...r });
      io.emit('history_cleared', { nickname: socket.data.nickname, timestamp: Date.now() });
      io.emit('system_message', {
        type: 'clear',
        nickname: socket.data.nickname,
        text: `${socket.data.nickname} 清空了聊天历史${data && data.includeStrokes ? '与白板' : ''}`,
        timestamp: Date.now()
      });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 历史分页：取 beforeId（AUTOINCREMENT 数字 id）之前的更早消息（升序；用于往上滚懒加载）
  socket.on('history_page', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    if (room !== 'main' && !canSendToRoom(room, socket.data.clientId)) {
      return cb({ ok: false, error: '无权限' });
    }
    const beforeId = Number((data && data.beforeId) || 0);
    if (!beforeId) return cb({ ok: false, error: '缺少 beforeId' });
    const limit = Math.min(Math.max(Number((data && data.limit) || 50), 1), 200);
    try {
      cb({ ok: true, room, history: decorateHistory(store.getMessagesBefore(room, beforeId, limit)) });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });
}

// history_search 的房间成员校验（与 rt-rooms.canSendToRoom 同规则；本地复制避免环依赖）
function canSendToRoom(roomId, clientId) {
  if (roomId === 'main') return true;
  const gr = groupRooms.get(roomId);
  return !!gr && !!clientId && gr.members.some((m) => m.clientId === clientId);
}

module.exports = { register };
