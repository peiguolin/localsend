// 数据持久化层：SQLite（better-sqlite3）
// 职责：自动建库（data/chat.db）、建表、聊天消息/白板笔迹的读写、
//       搜索、统计、导出、清空。全部同步 API（局域网规模毫秒级，无需异步）。
'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
// 库文件路径可用环境变量覆盖（测试用独立库，避免污染真实数据）
const DB_FILE = process.env.LOCALSEND_DB_FILE || path.join(DATA_DIR, 'chat.db');

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
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
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
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_client_id TEXT NOT NULL,
      owner_nick TEXT NOT NULL,
      members_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
  `);
  // 兼容旧库：已有表缺 client_id 列时补上
  const cols = db.prepare(`PRAGMA table_info(messages)`).all();
  if (!cols.some((c) => c.name === 'client_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN client_id TEXT`);
  }
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
    INSERT INTO messages (msg_id, room, type, nickname, sender_id, client_id, text, file_name, file_size, quote_json, recalled, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    msg.quote ? JSON.stringify(msg.quote) : null,
    msg.recalled ? 1 : 0,
    msg.timestamp || Date.now()
  );
  return msg;
}

// 读取历史：倒序取最近 N 条，再正序返回
function loadMessages(limit, room) {
  const d = getDb();
  const rows = d.prepare(`
    SELECT * FROM (
      SELECT id, msg_id AS mid, room, type, nickname, sender_id AS senderId, client_id AS clientId, text, file_name AS fileName,
             file_size AS fileSize, quote_json AS quoteJson, recalled, timestamp
      FROM messages
      WHERE room = ?
      ORDER BY id DESC
      LIMIT ?
    ) ORDER BY id ASC
  `).all(room || 'main', limit || HISTORY_LIMIT);
  return rows.map((r) => ({
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
           file_size AS fileSize, quote_json AS quoteJson, recalled, timestamp
    FROM messages WHERE ${where.join(' AND ')}
    ORDER BY id DESC LIMIT ?
  `).all(...args, Number(limit) || 100);
  return rows.map((r) => ({
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
    INSERT INTO rooms (id, name, owner_client_id, owner_nick, members_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    room.id,
    room.name,
    room.ownerClientId,
    room.ownerNick,
    JSON.stringify(room.members || []),
    room.createdAt || Date.now()
  );
  return room;
}

function loadRooms() {
  const d = getDb();
  const rows = d.prepare(`
    SELECT id, name, owner_client_id AS ownerClientId, owner_nick AS ownerNick,
           members_json AS membersJson, created_at AS createdAt
    FROM rooms ORDER BY created_at ASC
  `).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerClientId: r.ownerClientId,
    ownerNick: r.ownerNick,
    members: (() => { try { return JSON.parse(r.membersJson); } catch (_) { return []; } })(),
    createdAt: r.createdAt
  }));
}

function updateRoom(room) {
  const d = getDb();
  d.prepare(`
    UPDATE rooms SET name = ?, members_json = ? WHERE id = ?
  `).run(room.name, JSON.stringify(room.members || []), room.id);
}

function deleteRoom(id) {
  const d = getDb();
  d.prepare('DELETE FROM rooms WHERE id = ?').run(id);
}

module.exports = {
  DB_FILE, DATA_DIR,
  init, getDb, close,
  insertMessage, loadMessages, getMessageById, recallMessage, searchMessages, stats, clearHistory, trimMessages,
  insertStroke, loadStrokes, removeStrokeByAuthor, clearStrokes,
  createRoom, loadRooms, updateRoom, deleteRoom
};
