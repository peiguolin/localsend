// 数据持久化层：SQLite（Node 内置 node:sqlite，替代 better-sqlite3）
// 职责：自动建库（data/chat.db）、建表、聊天消息/白板笔迹的读写、
//       搜索、统计、导出、清空。全部同步 API（局域网规模毫秒级，无需异步）。
// 说明：node:sqlite 为 Node 22.5+ 内置模块（实验性，启动时有 ExperimentalWarning），
//       免去 better-sqlite3 原生编译依赖；库文件格式与 better-sqlite3 完全兼容。
'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { currentConfig } = require('./src/config');

const DATA_DIR = path.join(__dirname, 'data');
// 库文件路径：localsend.config.json 的 dbFile 或环境变量可覆盖（测试用独立库，避免污染真实数据）
const DB_FILE = currentConfig().dbFile || process.env.LOCALSEND_DB_FILE || path.join(DATA_DIR, 'chat.db');

// 消息保留上限：超过后按最旧裁剪
const MESSAGE_RETENTION = 10000;
// 历史加载默认条数
const HISTORY_LIMIT = 200;

let db = null;

// ---------- 初始化 ----------
function init() {
  if (db) return db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) { /* 目录已存在 */ }
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT,
      room TEXT NOT NULL DEFAULT 'main',
      type TEXT NOT NULL DEFAULT 'text',
      nickname TEXT NOT NULL,
      sender_id TEXT,
      client_id TEXT,
      text TEXT,
      file_name TEXT,
      file_size INTEGER,
      stored_name TEXT,
      quote_json TEXT,
      recalled INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(msg_id);
    CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room, timestamp);
    CREATE TABLE IF NOT EXISTS strokes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL DEFAULT 'main',
      stroke_id TEXT NOT NULL,
      author TEXT NOT NULL,
      author_id TEXT,
      color TEXT NOT NULL,
      size INTEGER NOT NULL,
      tool TEXT NOT NULL DEFAULT 'pen',
      pts_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_strokes_room ON strokes(room);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL DEFAULT 'main',
      event_date TEXT NOT NULL,
      event_time TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      creator_client_id TEXT NOT NULL DEFAULT '',
      creator_nick TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      remind_minutes INTEGER NOT NULL DEFAULT 0,
      reminded_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_room_date ON events(room, event_date);
    CREATE TABLE IF NOT EXISTS translations (
      source_hash TEXT NOT NULL,
      target TEXT NOT NULL,
      translation TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_hash, target)
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_client_id TEXT NOT NULL,
      owner_nick TEXT NOT NULL,
      members_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_admin (
      client_id TEXT PRIMARY KEY,
      banned INTEGER NOT NULL DEFAULT 0,
      ban_nickname TEXT NOT NULL DEFAULT '',
      ban_at INTEGER NOT NULL DEFAULT 0,
      mute_until INTEGER NOT NULL DEFAULT 0,
      bot_ban INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS room_bot (
      room_id TEXT PRIMARY KEY,
      enabled INTEGER,
      prompt TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
    CREATE TABLE IF NOT EXISTS pinned (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      pinned_at INTEGER NOT NULL,
      pinner TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_pinned_room ON pinned(room, pinned_at);
    CREATE TABLE IF NOT EXISTS announcements (
      room_id TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(room, msg_id, client_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(room, msg_id);
    -- 公网邀请模式（publicMode='invite'）：账号 / 邀请码 / 加入申请
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      banned INTEGER NOT NULL DEFAULT 0,
      created_ip TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_ip TEXT NOT NULL DEFAULT '',
      last_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_users_banned ON users(banned);
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL DEFAULT 0,
      used_count INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS join_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invite_code TEXT NOT NULL,
      username TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      ua TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT NOT NULL DEFAULT '',
      reviewed_by TEXT NOT NULL DEFAULT '',
      reviewed_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apps_status ON join_applications(status);
    CREATE INDEX IF NOT EXISTS idx_apps_ip ON join_applications(ip);
  `);
  // 兼容旧库：已有表缺 client_id 列时补上
  const cols = db.prepare(`PRAGMA table_info(messages)`).all();
  if (!cols.some((c) => c.name === 'client_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN client_id TEXT`);
  }
  // 兼容旧库：events 缺提醒列时补上（日程提醒功能）
  try {
    const evCols = d.prepare(`PRAGMA table_info(events)`).all();
    if (!evCols.some((c) => c.name === 'remind_minutes')) {
      db.exec(`ALTER TABLE events ADD COLUMN remind_minutes INTEGER NOT NULL DEFAULT 0`);
    }
    if (!evCols.some((c) => c.name === 'reminded_at')) {
      db.exec(`ALTER TABLE events ADD COLUMN reminded_at INTEGER NOT NULL DEFAULT 0`);
    }
  } catch (_) { /* events 表尚不存在时由上面的 CREATE 保证结构 */ }

  // 兼容旧库：缺 stored_name 列时补上（文件/图片消息刷新后恢复 URL 需要）
  if (!cols.some((c) => c.name === 'stored_name')) {
    db.exec(`ALTER TABLE messages ADD COLUMN stored_name TEXT`);
  }

  // 兼容旧库：rooms 缺 invite_token 列时补上（房间分享/扫码加入需要）
  try {
    const roomCols = db.prepare(`PRAGMA table_info(rooms)`).all();
    if (!roomCols.some((c) => c.name === 'invite_token')) {
      db.exec(`ALTER TABLE rooms ADD COLUMN invite_token TEXT NOT NULL DEFAULT ''`);
    }
  } catch (_) { /* rooms 表尚不存在时由上面的 CREATE 保证结构 */ }
  return db;
}

function getDb() {
  return init();
}

// ---------- 消息 ----------
// msg: {id, room?, type, nickname, senderId, clientId, text?, fileName?, fileSize?, quote?, timestamp, recalled?}
function insertMessage(msg) {
  const d = getDb();
  d.prepare(`
    INSERT INTO messages (msg_id, room, type, nickname, sender_id, client_id, text, file_name, file_size, stored_name, quote_json, recalled, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id || null,
    msg.room || 'main',
    msg.type || 'text',
    msg.nickname || '',
    msg.senderId || '',
    msg.clientId || '',
    msg.text || null,
    msg.fileName || null,
    msg.fileSize || null,
    msg.storedName || null,
    msg.quote ? JSON.stringify(msg.quote) : null,
    msg.recalled ? 1 : 0,
    msg.timestamp || Date.now()
  );
  return msg;
}

// 老消息恢复：把解析出的 storedName 回写 DB（按 msg_id，兜底按数字 id 主键）
function updateMessageStoredName(id, storedName) {
  const d = getDb();
  const n = d.prepare(`UPDATE messages SET stored_name = ? WHERE msg_id = ?`).run(storedName, String(id));
  if (n.changes === 0) {
    d.prepare(`UPDATE messages SET stored_name = ? WHERE id = ?`).run(storedName, Number(id) || 0);
  }
}

// 读取历史：倒序取最近 N 条，再正序返回
function loadMessages(limit, room) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT * FROM (
      SELECT id, msg_id AS mid, room, type, nickname, sender_id AS senderId, client_id AS clientId, text, file_name AS fileName,
             file_size AS fileSize, stored_name AS storedName, quote_json AS quoteJson, recalled, timestamp
      FROM messages
      WHERE room = ?
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `).all(room || 'main', limit || HISTORY_LIMIT);
  return rows.map((r) => ({
    id: r.mid || String(r.id),
    numericId: r.id, // AUTOINCREMENT 稳定排序键（历史分页用）
    room: r.room,
    type: r.type,
    nickname: r.nickname,
    senderId: r.senderId,
    clientId: r.clientId || '',
    text: r.text,
    fileName: r.fileName,
    fileSize: r.fileSize,
    storedName: r.storedName || null,
    quote: r.quoteJson ? JSON.parse(r.quoteJson) : null,
    recalled: !!r.recalled,
    timestamp: r.timestamp
  }));
}

// 撤回：按 msg_id 或数字 id 更新 recalled 状态
function recallMessage(id) {
  const d = getDb();
  const key = String(id || '');
  if (/^m/.test(key)) {
    return d.prepare('UPDATE messages SET recalled = 1 WHERE msg_id = ?').run(key).changes > 0;
  }
  return d.prepare('UPDATE messages SET recalled = 1 WHERE id = ?').run(Number(key) || 0).changes > 0;
}

// 按 id（msg_id 或数字 id）精确取一条消息
function getMessageById(id) {
  const d = getDb();
  const key = String(id || '');
  const r = /^m/.test(key)
    ? d.prepare('SELECT id, msg_id AS mid, room, type, nickname, sender_id AS senderId, client_id AS clientId, text, file_name AS fileName, file_size AS fileSize, quote_json AS quoteJson, recalled, timestamp FROM messages WHERE msg_id = ? LIMIT 1').get(key)
    : d.prepare('SELECT id, msg_id AS mid, room, type, nickname, sender_id AS senderId, client_id AS clientId, text, file_name AS fileName, file_size AS fileSize, quote_json AS quoteJson, recalled, timestamp FROM messages WHERE id = ? LIMIT 1').get(Number(key) || 0);
  if (!r) return null;
  return {
    id: r.mid || String(r.id),
    room: r.room,
    type: r.type,
    nickname: r.nickname,
    senderId: r.senderId,
    clientId: r.clientId || '',
    text: r.text,
    fileName: r.fileName,
    fileSize: r.fileSize,
    quote: r.quoteJson ? JSON.parse(r.quoteJson) : null,
    recalled: !!r.recalled,
    timestamp: r.timestamp
  };
}

// 搜索：关键词（LIKE）/ 昵称 / 时间范围
function searchMessages(opts) {
  const d = getDb();
  const { keyword, nickname, from, to, room, limit } = opts || {};
  const where = ['room = ?'];
  const args = [room || 'main'];
  if (keyword) {
    where.push('(text LIKE ? OR file_name LIKE ?)');
    const kw = `%${keyword}%`;
    args.push(kw, kw);
  }
  if (nickname) { where.push('nickname = ?'); args.push(nickname); }
  if (from) { where.push('timestamp >= ?'); args.push(Number(from)); }
  if (to) { where.push('timestamp <= ?'); args.push(Number(to)); }
  const rows = d.prepare(`
    SELECT id, msg_id AS mid, room, type, nickname, sender_id AS senderId, client_id AS clientId, text, file_name AS fileName,
           file_size AS fileSize, stored_name AS storedName, quote_json AS quoteJson, recalled, timestamp
    FROM messages WHERE ${where.join(' AND ')}
    ORDER BY id DESC LIMIT ?
  `).all(...args, Number(limit) || 100);
  return rows.map((r) => ({
    id: r.mid || String(r.id),
    numericId: r.id, // AUTOINCREMENT 稳定排序键（历史分页用）
    room: r.room,
    type: r.type,
    nickname: r.nickname,
    senderId: r.senderId,
    clientId: r.clientId || '',
    text: r.text,
    fileName: r.fileName,
    fileSize: r.fileSize,
    storedName: r.storedName || null,
    quote: r.quoteJson ? JSON.parse(r.quoteJson) : null,
    recalled: !!r.recalled,
    timestamp: r.timestamp
  }));
}

// 统计
function stats(room) {
  const d = getDb();
  const m = d.prepare('SELECT COUNT(*) AS n FROM messages WHERE room = ?').get(room || 'main');
  const f = d.prepare('SELECT COUNT(*) AS n FROM messages WHERE room = ? AND type != \'text\'').get(room || 'main');
  const s = d.prepare('SELECT COUNT(*) AS n FROM strokes WHERE room = ?').get(room || 'main');
  const rng = d.prepare('SELECT MIN(timestamp) AS first, MAX(timestamp) AS last FROM messages WHERE room = ?').get(room || 'main');
  return {
    messages: m.n,
    files: f.n,
    strokes: s.n,
    firstAt: rng.first || null,
    lastAt: rng.last || null,
    dbBytes: db ? (fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0) : 0
  };
}

// 清空消息（可选连带白板）
function clearHistory(room, includeStrokes) {
  const d = getDb();
  const r = d.prepare('DELETE FROM messages WHERE room = ?').run(room || 'main');
  if (includeStrokes) d.prepare('DELETE FROM strokes WHERE room = ?').run(room || 'main');
  return { messages: r.changes };
}

// 某 clientId / 账号名下文件消息累计字节（每人上传配额用；撤回/清理自动反映）
function sumFileBytesByClient(clientId) {
  const d = getDb();
  const r = d.prepare(`
    SELECT COALESCE(SUM(file_size), 0) AS total
    FROM messages WHERE client_id = ? AND file_size IS NOT NULL AND recalled != 1
  `).get(String(clientId || ''));
  return Number((r && r.total) || 0);
}

// 所有被消息引用的 stored_name 集合（生命周期清扫时判断文件是否仍被引用）
function listReferencedStoredNames() {
  const d = getDb();
  const rows = d.prepare(`SELECT DISTINCT stored_name AS sn FROM messages WHERE stored_name IS NOT NULL AND stored_name != ''`).all();
  return new Set(rows.map((r) => r.sn));
}

// 按时间清理过期消息（数据保留策略）；返回删除条数
function trimMessagesByAge(cutoffTs) {
  const d = getDb();
  const r = d.prepare('DELETE FROM messages WHERE timestamp < ?').run(Number(cutoffTs) || 0);
  return { messages: r.changes };
}

// ---------- 翻译缓存（按原文哈希共享：同一文本全房间只算一次） ----------
function getTranslation(sourceHash, target) {
  const d = getDb();
  const r = d.prepare('SELECT translation, engine, created_at AS createdAt FROM translations WHERE source_hash = ? AND target = ?')
    .get(String(sourceHash), String(target));
  return r || null;
}

function saveTranslation(sourceHash, target, translation, engine) {
  const d = getDb();
  d.prepare(`
    INSERT INTO translations (source_hash, target, translation, engine, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source_hash, target) DO UPDATE SET
      translation = excluded.translation, engine = excluded.engine, created_at = excluded.created_at
  `).run(String(sourceHash), String(target), String(translation), String(engine || ''), Date.now());
}

// ---------- 日历日程 ----------
function createEvent(ev) {
  const d = getDb();
  const r = d.prepare(`
    INSERT INTO events (room, event_date, event_time, title, note, creator_client_id, creator_nick, created_at, remind_minutes, reminded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    ev.room || 'main', ev.event_date, ev.event_time || '', ev.title,
    ev.note || '', ev.creator_client_id || '', ev.creator_nick || '', ev.created_at || Date.now(),
    Number(ev.remind_minutes) || 0
  );
  return Number(r.lastInsertRowid);
}

const EVENT_COLS = `id, room, event_date AS date, event_time AS time, title, note,
       creator_client_id AS creatorClientId, creator_nick AS creatorNick, created_at AS createdAt,
       remind_minutes AS remindMinutes, reminded_at AS remindedAt`;

function listEvents(room, fromDate, toDate) {
  const d = getDb();
  return d.prepare(`
    SELECT ${EVENT_COLS}
    FROM events WHERE room = ? AND event_date >= ? AND event_date <= ?
    ORDER BY event_date ASC, event_time ASC, id ASC
  `).all(room || 'main', fromDate, toDate);
}

function getEvent(id) {
  const d = getDb();
  const r = d.prepare(`SELECT ${EVENT_COLS} FROM events WHERE id = ?`).get(Number(id));
  return r || null;
}

function deleteEvent(id) {
  const d = getDb();
  return d.prepare('DELETE FROM events WHERE id = ?').run(Number(id)).changes;
}

// 待触发的提醒（已到/未到触发时间由调用方按本地时间计算）
function listUnfiredReminders() {
  const d = getDb();
  return d.prepare(`SELECT ${EVENT_COLS} FROM events WHERE remind_minutes > 0 AND reminded_at = 0`).all();
}

function markEventReminded(id, ts) {
  const d = getDb();
  d.prepare('UPDATE events SET reminded_at = ? WHERE id = ?').run(Number(ts) || Date.now(), Number(id));
}

// ---------- 白板笔迹 ----------
function insertStroke(s) {
  const d = getDb();
  d.prepare(`
    INSERT INTO strokes (room, stroke_id, author, author_id, color, size, tool, pts_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.room || 'main',
    s.id || '',
    s.author || '',
    s.authorId || '',
    s.color || '#1f2328',
    s.size || 4,
    s.tool || 'pen',
    JSON.stringify(s.pts || []),
    s.timestamp || Date.now()
  );
}

function loadStrokes(room) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, room, stroke_id AS sid, author, author_id AS authorId, color, size, tool, pts_json AS ptsJson, timestamp
    FROM strokes WHERE room = ? ORDER BY id ASC
  `).all(room || 'main');
  return rows.map((r) => ({
    id: r.sid,
    author: r.author,
    authorId: r.authorId,
    color: r.color,
    size: r.size,
    tool: r.tool,
    pts: JSON.parse(r.ptsJson || '[]')
  }));
}

function removeStrokeByAuthor(authorId) {
  const d = getDb();
  const row = d.prepare(`
    SELECT stroke_id AS sid FROM strokes
    WHERE author_id = ? ORDER BY id DESC LIMIT 1
  `).get(authorId);
  if (!row) return null;
  d.prepare('DELETE FROM strokes WHERE stroke_id = ?').run(row.sid);
  return row.sid;
}

function clearStrokes(room) {
  const d = getDb();
  return d.prepare('DELETE FROM strokes WHERE room = ?').run(room || 'main').changes;
}

// 消息裁剪：超过上限删最旧
function trimMessages(room) {
  const d = getDb();
  d.prepare(`
    DELETE FROM messages WHERE room = ? AND id NOT IN (
      SELECT id FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?
    )
  `).run(room || 'main', room || 'main', MESSAGE_RETENTION);
}

function close() {
  if (db) { try { db.close(); } catch (_) {} db = null; }
}

// ---------- 群聊房间 ----------
// room 对象：{ id, name, ownerClientId, ownerNick, members: [{ clientId, nickname }], createdAt }
// members 序列化为 JSON 存 members_json（持久化成员身份用 clientId，socketId 每次连接都变）

function createRoom(room) {
  const d = getDb();
  d.prepare(`
    INSERT INTO rooms (id, name, owner_client_id, owner_nick, members_json, created_at, invite_token)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    room.id,
    room.name,
    room.ownerClientId,
    room.ownerNick,
    JSON.stringify(room.members || []),
    room.createdAt || Date.now(),
    room.inviteToken || ''
  );
  return room;
}

function loadRooms() {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, name, owner_client_id AS ownerClientId, owner_nick AS ownerNick,
           members_json AS membersJson, created_at AS createdAt, invite_token AS inviteToken
    FROM rooms ORDER BY created_at ASC
  `).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerClientId: r.ownerClientId,
    ownerNick: r.ownerNick,
    members: (() => { try { return JSON.parse(r.membersJson); } catch (_) { return []; } })(),
    createdAt: r.createdAt,
    inviteToken: r.inviteToken || ''
  }));
}

function updateRoom(room) {
  const d = getDb();
  d.prepare(`
    UPDATE rooms SET name = ?, members_json = ?, invite_token = ? WHERE id = ?
  `).run(room.name, JSON.stringify(room.members || []), room.inviteToken || '', room.id);
}

function deleteRoom(id) {
  const d = getDb();
  d.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

// ---------- 置顶消息 ----------
function listPins(room) {
  const d = getDb();
  return d.prepare(`
    SELECT id, room, msg_id AS msgId, pinned_at AS pinnedAt, pinner
    FROM pinned WHERE room = ? ORDER BY pinned_at DESC
  `).all(room || 'main');
}

function addPin(room, msgId, pinner) {
  const d = getDb();
  const exists = d.prepare('SELECT id FROM pinned WHERE room = ? AND msg_id = ?').get(room || 'main', String(msgId));
  if (exists) return false;
  d.prepare('INSERT INTO pinned (room, msg_id, pinned_at, pinner) VALUES (?, ?, ?, ?)')
    .run(room || 'main', String(msgId), Date.now(), String(pinner || ''));
  return true;
}

function removePin(room, msgId) {
  const d = getDb();
  return d.prepare('DELETE FROM pinned WHERE room = ? AND msg_id = ?')
    .run(room || 'main', String(msgId)).changes > 0;
}

// 清空某房间的全部置顶（历史清空/房间解散时联动）
function clearPins(room) {
  const d = getDb();
  return d.prepare('DELETE FROM pinned WHERE room = ?').run(room || 'main').changes;
}

// ---------- 群公告（每房间一条，房主/宿主机可改） ----------
function setAnnouncement(room, text, author) {
  const d = getDb();
  d.prepare(`
    INSERT INTO announcements (room_id, text, author, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET text=excluded.text, author=excluded.author, updated_at=excluded.updated_at
  `).run(String(room || 'main'), String(text || ''), String(author || ''), Date.now());
}

function getAnnouncement(room) {
  const d = getDb();
  return d.prepare('SELECT room_id AS room, text, author, updated_at AS updatedAt FROM announcements WHERE room_id = ?')
    .get(String(room || 'main')) || null;
}

function deleteAnnouncement(room) {
  const d = getDb();
  d.prepare('DELETE FROM announcements WHERE room_id = ?').run(String(room || 'main'));
}

// ---------- 消息表情回应（实时广播 + 持久化；同人同消息同表情唯一） ----------
// 添加回应：已存在则返回 false（不重复计数）；新增返回 true
function addReaction(room, msgId, clientId, nickname, emoji) {
  const d = getDb();
  const exists = d.prepare('SELECT id FROM reactions WHERE room = ? AND msg_id = ? AND client_id = ? AND emoji = ?')
    .get(String(room || 'main'), String(msgId), String(clientId || ''), String(emoji || ''));
  if (exists) return false;
  d.prepare('INSERT INTO reactions (room, msg_id, client_id, nickname, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(room || 'main'), String(msgId), String(clientId || ''), String(nickname || ''), String(emoji || ''), Date.now());
  return true;
}

// 取消回应：返回是否确实移除
function removeReaction(room, msgId, clientId, emoji) {
  const d = getDb();
  return d.prepare('DELETE FROM reactions WHERE room = ? AND msg_id = ? AND client_id = ? AND emoji = ?')
    .run(String(room || 'main'), String(msgId), String(clientId || ''), String(emoji || '')).changes > 0;
}

// 批量取一批消息的回应（历史/搜索装饰用）：返回 [{msgId, reactions:[{emoji, count, names, clientIds}]}]
// 为控制体积 names/clientIds 截断到前 20 个，count 用真实总数
function loadReactionsForMessages(room, msgIds) {
  const d = getDb();
  if (!Array.isArray(msgIds) || !msgIds.length) return [];
  const ids = msgIds.map((x) => String(x));
  const rows = d.prepare(`
    SELECT msg_id AS msgId, emoji, nickname, client_id AS clientId,
           COUNT(*) OVER (PARTITION BY msg_id, emoji) AS cnt
    FROM reactions WHERE room = ? AND msg_id IN (${ids.map(() => '?').join(',')})
    ORDER BY created_at ASC
  `).all(String(room || 'main'), ...ids);
  // 聚合（按 消息|表情 去重，保留昵称/客户端 id 列表）
  const map = new Map(); // key = msgId|emoji -> {emoji, count, names, clientIds}
  for (const r of rows) {
    const k = `${r.msgId}|${r.emoji}`;
    let agg = map.get(k);
    if (!agg) {
      agg = { emoji: r.emoji, count: Number(r.cnt) || 0, names: [], clientIds: [] };
      map.set(k, agg);
    }
    if (agg.names.length < 20 && r.nickname && !agg.names.includes(r.nickname)) agg.names.push(r.nickname);
    if (agg.clientIds.length < 20 && r.clientId && !agg.clientIds.includes(r.clientId)) agg.clientIds.push(r.clientId);
  }
  // 按消息分组输出
  const byMsg = new Map();
  for (const [k, agg] of map) {
    const msgId = k.slice(0, k.lastIndexOf('|'));
    if (!byMsg.has(msgId)) byMsg.set(msgId, []);
    byMsg.get(msgId).push(agg);
  }
  return ids.map((id) => ({ msgId: id, reactions: byMsg.get(id) || [] }));
}

// 清空某房间全部回应（历史清空/房间解散时联动）
function clearReactionsForRoom(room) {
  const d = getDb();
  return d.prepare('DELETE FROM reactions WHERE room = ?').run(String(room || 'main')).changes;
}

// ---------- 用户管理状态（剔除/禁言/禁机器人，跨重启持久） ----------
function loadUserAdmin() {
  const d = getDb();
  return d.prepare(`
    SELECT client_id AS cid, banned, ban_nickname AS banNick, ban_at AS banAt,
           mute_until AS muteUntil, bot_ban AS botBan
    FROM user_admin
  `).all();
}

function setUserAdmin(clientId, patch) {
  const d = getDb();
  d.prepare(`
    INSERT INTO user_admin (client_id, banned, ban_nickname, ban_at, mute_until, bot_ban)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET
      banned=excluded.banned, ban_nickname=excluded.ban_nickname, ban_at=excluded.ban_at,
      mute_until=excluded.mute_until, bot_ban=excluded.bot_ban
  `).run(
    String(clientId),
    patch.banned ? 1 : 0,
    patch.banNickname || '',
    patch.banAt || 0,
    patch.muteUntil || 0,
    patch.botBan ? 1 : 0
  );
}

// ---------- 历史分页：取某条（numericId）之前的更早消息（升序返回） ----------
function getMessagesBefore(room, beforeId, limit) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, msg_id AS mid, room, type, nickname, sender_id AS senderId, client_id AS clientId, text, file_name AS fileName,
           file_size AS fileSize, stored_name AS storedName, quote_json AS quoteJson, recalled, timestamp
    FROM messages
    WHERE room = ? AND id < ?
    ORDER BY id DESC
    LIMIT ?
  `).all(room || 'main', Number(beforeId) || 0, limit || 50);
  return rows.reverse().map((r) => ({
    id: r.mid || String(r.id),
    numericId: r.id, // AUTOINCREMENT 稳定排序键（历史分页用）
    room: r.room,
    type: r.type,
    nickname: r.nickname,
    senderId: r.senderId,
    clientId: r.clientId || '',
    text: r.text,
    fileName: r.fileName,
    fileSize: r.fileSize,
    storedName: r.storedName || null,
    quote: r.quoteJson ? JSON.parse(r.quoteJson) : null,
    recalled: !!r.recalled,
    timestamp: r.timestamp
  }));
}

// ---------- 房间级机器人覆盖（enabled: null=继承全局 / 0=关 / 1=开；prompt: null=继承） ----------
function loadRoomBot() {
  const d = getDb();
  return d.prepare('SELECT room_id AS room, enabled, prompt FROM room_bot').all();
}

function setRoomBot(room, enabled, prompt) {
  const d = getDb();
  d.prepare(`
    INSERT INTO room_bot (room_id, enabled, prompt) VALUES (?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET enabled=excluded.enabled, prompt=excluded.prompt
  `).run(
    String(room),
    enabled === null || enabled === undefined ? null : (enabled ? 1 : 0),
    prompt === undefined ? null : prompt
  );
}

// ---------- 公网邀请模式：账号 / 邀请码 / 加入申请 ----------

// 按用户名取账号（登录用；未找到返回 null）
function getUserByUsername(username) {
  const d = getDb();
  return d.prepare(`
    SELECT id, username, pass_hash AS passHash, nickname, role, banned,
           created_ip AS createdIp, created_at AS createdAt, last_ip AS lastIp, last_seen AS lastSeen
    FROM users WHERE username = ?
  `).get(String(username || ''));
}

function getUserById(id) {
  const d = getDb();
  return d.prepare(`
    SELECT id, username, pass_hash AS passHash, nickname, role, banned,
           created_ip AS createdIp, created_at AS createdAt, last_ip AS lastIp, last_seen AS lastSeen
    FROM users WHERE id = ?
  `).get(String(id || ''));
}

// 新建账号（审批通过时调用）
function insertUser(user) {
  const d = getDb();
  d.prepare(`
    INSERT INTO users (id, username, pass_hash, nickname, role, banned, created_ip, created_at, last_ip, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(user.id), String(user.username), String(user.passHash),
    String(user.nickname || ''), String(user.role || 'user'),
    user.banned ? 1 : 0, String(user.createdIp || ''), Number(user.createdAt) || Date.now(),
    String(user.lastIp || ''), Number(user.lastSeen) || 0
  );
}

function setUserBanned(id, banned) {
  const d = getDb();
  d.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, String(id || ''));
}

function setUserNickname(id, nickname) {
  const d = getDb();
  d.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(String(nickname || ''), String(id || ''));
}

// 管理员权限分配（role: 'admin' | 'user'）
function setUserRole(username, role) {
  const d = getDb();
  const r = d.prepare('UPDATE users SET role = ? WHERE username = ?')
    .run(String(role === 'admin' ? 'admin' : 'user'), String(username || ''));
  return r.changes > 0;
}

// 更新账号密码（scrypt 哈希由上层生成）
function setUserPassword(id, passHash) {
  const d = getDb();
  d.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(String(passHash || ''), String(id || ''));
}

function touchUser(id, ip) {
  const d = getDb();
  d.prepare('UPDATE users SET last_ip = ?, last_seen = ? WHERE id = ?')
    .run(String(ip || ''), Date.now(), String(id || ''));
}

function listUsers() {
  const d = getDb();
  return d.prepare(`
    SELECT id, username, nickname, role, banned, created_ip AS createdIp, created_at AS createdAt,
           last_ip AS lastIp, last_seen AS lastSeen
    FROM users ORDER BY created_at DESC
  `).all();
}

// 同 IP 已建账号数（防一人多号）
function countUsersByIp(ip) {
  const d = getDb();
  const r = d.prepare('SELECT COUNT(*) AS n FROM users WHERE created_ip = ?').get(String(ip || ''));
  return r ? r.n : 0;
}

// 邀请码
function insertInvite(inv) {
  const d = getDb();
  d.prepare(`
    INSERT INTO invites (code, note, created_by, created_at, expires_at, used_count, max_uses)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(inv.code), String(inv.note || ''), String(inv.createdBy || ''),
    Number(inv.createdAt) || Date.now(), Number(inv.expiresAt) || 0,
    Number(inv.usedCount) || 0, Number(inv.maxUses) || 1
  );
}

function getInvite(code) {
  const d = getDb();
  return d.prepare(`
    SELECT code, note, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt,
           used_count AS usedCount, max_uses AS maxUses
    FROM invites WHERE code = ?
  `).get(String(code || ''));
}

function listInvites() {
  const d = getDb();
  return d.prepare(`
    SELECT code, note, created_by AS createdBy, created_at AS createdAt, expires_at AS expiresAt,
           used_count AS usedCount, max_uses AS maxUses
    FROM invites ORDER BY created_at DESC
  `).all();
}

function deleteInvite(code) {
  const d = getDb();
  d.prepare('DELETE FROM invites WHERE code = ?').run(String(code || ''));
}

// 审批通过后邀请码使用计数 +1
function bumpInviteUsed(code) {
  const d = getDb();
  d.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ?').run(String(code || ''));
}

// 加入申请
function insertJoinApplication(app) {
  const d = getDb();
  const r = d.prepare(`
    INSERT INTO join_applications (invite_code, username, pass_hash, nickname, ip, ua, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    String(app.inviteCode), String(app.username), String(app.passHash),
    String(app.nickname || ''), String(app.ip || ''), String(app.ua || ''), Number(app.createdAt) || Date.now()
  );
  return Number(r.lastInsertRowid);
}

function getJoinApplication(id) {
  const d = getDb();
  return d.prepare(`
    SELECT id, invite_code AS inviteCode, username, pass_hash AS passHash, nickname, ip, ua,
           status, reject_reason AS rejectReason, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt, created_at AS createdAt
    FROM join_applications WHERE id = ?
  `).get(Number(id) || 0);
}

// pending 列表（按新到旧）
function listPendingApplications() {
  const d = getDb();
  return d.prepare(`
    SELECT id, invite_code AS inviteCode, username, nickname, ip, ua, status,
           reject_reason AS rejectReason, reviewed_at AS reviewedAt, created_at AS createdAt
    FROM join_applications ORDER BY created_at DESC
  `).all();
}

// 状态流转：pending -> approved / rejected
function setApplicationStatus(id, status, reviewedBy, reason) {
  const d = getDb();
  d.prepare(`
    UPDATE join_applications SET status = ?, reviewed_by = ?, reviewed_at = ?, reject_reason = ?
    WHERE id = ?
  `).run(
    String(status || 'rejected'), String(reviewedBy || ''), Date.now(),
    String(reason || ''), Number(id) || 0
  );
}

// 某用户名是否已被占用（账号或 pending 申请）
function usernameTaken(username) {
  const d = getDb();
  const u = String(username || '');
  const a = d.prepare('SELECT 1 FROM users WHERE username = ?').get(u);
  if (a) return true;
  const b = d.prepare("SELECT 1 FROM join_applications WHERE username = ? AND status = 'pending'").get(u);
  return !!b;
}

// 该邀请码已关联的申请数（pending + approved；超出 max_uses 则拒绝新申请）
function applicationCountByInvite(code) {
  const d = getDb();
  const r = d.prepare("SELECT COUNT(*) AS n FROM join_applications WHERE invite_code = ? AND status IN ('pending','approved')")
    .get(String(code || ''));
  return r ? r.n : 0;
}

// 同 IP 申请数（pending + approved；防刷申请）
function applicationCountByIp(ip) {
  const d = getDb();
  const r = d.prepare("SELECT COUNT(*) AS n FROM join_applications WHERE ip = ? AND status IN ('pending','approved')")
    .get(String(ip || ''));
  return r ? r.n : 0;
}

// 同 IP 未决申请数（pending 只算一次，审批后归入账号）
function countPendingByIp(ip) {
  const d = getDb();
  const r = d.prepare("SELECT COUNT(*) AS n FROM join_applications WHERE ip = ? AND status = 'pending'")
    .get(String(ip || ''));
  return r ? r.n : 0;
}

// ---------- 管理审计日志（剔除/禁言/禁机器人/改配置；宿主机可翻，跨重启保留） ----------
function insertAudit(entry) {
  const d = getDb();
  d.prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)').run(
    entry.at || Date.now(),
    String(entry.actor || ''),
    String(entry.action || ''),
    String(entry.target || ''),
    String(entry.detail || '')
  );
}

function listAudit(limit) {
  const d = getDb();
  return d.prepare(`
    SELECT at, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT ?
  `).all(Math.min(Number(limit) || 50, 200));
}

module.exports = {
  DB_FILE, DATA_DIR,
  init, getDb, close,
  insertMessage, loadMessages, getMessageById, recallMessage, searchMessages, stats, clearHistory, trimMessages, updateMessageStoredName,
  listReferencedStoredNames, trimMessagesByAge, sumFileBytesByClient,
  insertStroke, loadStrokes, removeStrokeByAuthor, clearStrokes,
  createRoom, loadRooms, updateRoom, deleteRoom,
  createEvent, listEvents, getEvent, deleteEvent, listUnfiredReminders, markEventReminded,
  getTranslation, saveTranslation,
  loadUserAdmin, setUserAdmin, getMessagesBefore, loadRoomBot, setRoomBot,
  insertAudit, listAudit,
  listPins, addPin, removePin, clearPins,
  setAnnouncement, getAnnouncement, deleteAnnouncement,
  addReaction, removeReaction, loadReactionsForMessages, clearReactionsForRoom,
  getUserByUsername, getUserById, insertUser, setUserBanned, setUserNickname, setUserRole, setUserPassword, touchUser, listUsers, countUsersByIp,
  insertInvite, getInvite, listInvites, deleteInvite, bumpInviteUsed,
  insertJoinApplication, getJoinApplication, listPendingApplications, setApplicationStatus,
  usernameTaken, applicationCountByInvite, applicationCountByIp, countPendingByIp
};
