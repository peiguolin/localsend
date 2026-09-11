const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const multer = require('multer');
const store = require('./db.js');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const META_FILE = path.join(UPLOAD_DIR, '.meta.json');
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');

// 可在线预览的图片类型白名单（不含 SVG：SVG 可内嵌脚本，出于安全一律按普通文件处理）
const IMAGE_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

// 确保 uploads 目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---------- HTTPS 证书（File System Access API 要求安全上下文） ----------
function ensureCerts() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) return true;
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const { execSync } = require('child_process');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
      `-days 3650 -nodes -subj "/CN=localsend-chat" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: 'ignore' }
    );
    return fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE);
  } catch (_) {
    return false;
  }
}

if (!ensureCerts()) {
  console.error('未找到 HTTPS 证书且自动生成失败。请手动执行：');
  console.error('  mkdir -p certs && openssl req -x509 -newkey rsa:2048 \\');
  console.error('    -keyout certs/key.pem -out certs/cert.pem -days 3650 -nodes \\');
  console.error('    -subj "/CN=localsend-chat" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"');
  process.exit(1);
}

const app = express();
const server = https.createServer({
  key: fs.readFileSync(KEY_FILE),
  cert: fs.readFileSync(CERT_FILE)
}, app);
const io = new Server(server);

// ---------- 静态资源 ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 文件元数据持久化（用于下载时还原原始文件名） ----------
function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveMeta(storedName, originalName, size) {
  const db = loadMeta();
  db[storedName] = { originalName, size, uploadedAt: Date.now() };
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(db, null, 2));
  } catch (_) {
    /* 元数据写失败不阻塞主流程 */
  }
}

function getOriginalName(storedName) {
  const db = loadMeta();
  return (db[storedName] && db[storedName].originalName) || storedName;
}

// multer/busboy 默认按 latin1 解码文件名，需还原为 UTF-8（浏览器 FormData 发送 UTF-8 文件名）
function decodeOriginalName(name) {
  try {
    const buf = Buffer.from(String(name), 'latin1');
    const utf8 = buf.toString('utf8');
    // 还原结果含替换字符说明原本不是 latin1 编码，保持原样
    return utf8.includes('�') ? String(name) : utf8;
  } catch (_) {
    return String(name);
  }
}

// ---------- 图片识别（扩展名白名单 + 文件头魔数双重校验） ----------
function checkImageMagic(storedPath, ext) {
  try {
    const fd = fs.openSync(storedPath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    switch (ext) {
      case '.png':
        return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      case '.jpg':
      case '.jpeg':
        return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      case '.gif':
        return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
      case '.webp':
        return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
               buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
      case '.bmp':
        return buf[0] === 0x42 && buf[1] === 0x4d;
      default:
        return false;
    }
  } catch (_) {
    return false;
  }
}

function detectImageMime(storedName, storedPath) {
  const ext = path.extname(storedName).toLowerCase();
  const mime = IMAGE_MIMES[ext];
  if (!mime) return null;
  return checkImageMagic(storedPath, ext) ? mime : null;
}

// ---------- 存储文件定位（防路径穿越，供下载/预览共用） ----------
const STORED_NAME_RE = /^[0-9]+-[a-f0-9]{12}(\.[a-zA-Z0-9]{1,10})?$/;

function resolveStoredFile(raw) {
  if (!raw || !STORED_NAME_RE.test(raw)) return null;
  const resolved = path.resolve(UPLOAD_DIR, raw);
  const uploadRoot = path.resolve(UPLOAD_DIR);
  if (resolved !== uploadRoot && !resolved.startsWith(uploadRoot + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

// Content-Disposition（RFC 5987，支持中文文件名）
function contentDisposition(filename, type = 'attachment') {
  const fallback = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------- 文件上传（multer） ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // 还原中文原始文件名，存入 file.decodedName 供后续展示与元数据记录
    file.decodedName = decodeOriginalName(file.originalname);
    // 生成安全存储名：时间戳 + 随机串 + 安全扩展名（原始中文名仅用于展示）
    const ext = path.extname(file.decodedName || '').replace(/[^a-zA-Z0-9.]/g, '');
    const safeExt = ext.length > 1 && ext.length <= 10 ? ext : '';
    const storeName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`;
    cb(null, storeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// POST /upload —— 单文件上传
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: '未收到文件' });
  }
  const storedName = req.file.filename;
  const originalName = req.file.decodedName || req.file.originalname || storedName;
  const size = req.file.size;
  const downloadUrl = `/download/${encodeURIComponent(storedName)}`;

  // 记录原始文件名，供下载时还原 Content-Disposition
  saveMeta(storedName, originalName, size);

  const nickname = (req.body && req.body.nickname) || '匿名';
  const base = { id: nextMsgId(), nickname, fileName: originalName, storedName, size, downloadUrl, timestamp: Date.now() };

  // 图片文件：广播 type:'image' 并带上预览地址，前端直接渲染在线预览
  const mime = detectImageMime(storedName, req.file.path);
  if (mime) {
    const imageUrl = `/images/${encodeURIComponent(storedName)}`;
    const msg = { ...base, type: 'image', imageUrl };
    chatLogPush(msg);
    store.insertMessage(msg);
    io.emit('chat_message', msg);
    return res.json({ ok: true, ...base, type: 'image', imageUrl });
  }

  // 其余文件保持原文件卡片行为
  const msg = { ...base, type: 'file' };
  chatLogPush(msg);
  store.insertMessage(msg);
  io.emit('chat_message', msg);
  res.json({ ok: true, ...base, type: 'file' });
});

// 上传错误处理（如超限）
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: '文件超过 200MB 大小限制' });
    }
    return res.status(400).json({ ok: false, error: `上传失败：${err.message}` });
  }
  if (err) {
    return res.status(500).json({ ok: false, error: `服务器错误：${err.message}` });
  }
  next();
});

// ---------- 数据导出（下载 SQLite 库文件备份） ----------
app.get('/data-export', (req, res) => {
  try {
    if (!fs.existsSync(store.DB_FILE)) return res.status(404).send('数据库文件不存在');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    res.download(store.DB_FILE, `localsend-chat-${stamp}.db`);
  } catch (e) {
    res.status(500).send(`导出失败：${e.message}`);
  }
});

// ---------- 下载（防路径穿越） ----------
app.get('/download/:filename', (req, res) => {
  const raw = req.params.filename;
  if (!raw || !STORED_NAME_RE.test(raw)) {
    return res.status(400).send('文件名无效');
  }
  const resolved = resolveStoredFile(raw);
  if (!resolved) {
    return res.status(404).send('文件不存在或已被删除');
  }
  res.download(resolved, getOriginalName(raw));
});

// ---------- 图片在线预览（内联返回 + 可缓存） ----------
app.get('/images/:filename', (req, res) => {
  const raw = req.params.filename;
  if (!raw || !STORED_NAME_RE.test(raw)) {
    return res.status(400).send('文件名无效');
  }
  const resolved = resolveStoredFile(raw);
  if (!resolved) {
    return res.status(404).send('文件不存在或已被删除');
  }
  const mime = detectImageMime(raw, resolved);
  if (!mime) {
    return res.status(400).send('非图片文件');
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${raw}"`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(resolved).pipe(res);
});

// ============================================================
//  文件夹共享（File System Access API + 服务器中转）
// ============================================================

// 共享注册表：shareId -> { id, name, ownerId, ownerNick, salt, passwordHash, canWrite, writable, createdAt }
const shares = new Map();
// 访问令牌：token -> { shareId, socketId, isOwner }
const shareTokens = new Map();
// 进行中的中转传输：transferId -> { kind:'push'|'pull', shareId, req?, res, started, timer }
const pendingTransfers = new Map();

const TRANSFER_START_TIMEOUT = 60 * 1000;   // 共享者开始推/拉流的最长等待
const OWNER_ACK_TIMEOUT = 30 * 1000;        // list/read 操作的共享者响应超时
const WRITE_ACK_TIMEOUT = 30 * 60 * 1000;   // write 操作需覆盖整个传输时长

function hashPassword(pw, salt) {
  return crypto.createHash('sha256').update(`${salt}:${pw}`).digest('hex');
}

function issueToken(shareId, socketId, isOwner) {
  const token = crypto.randomBytes(24).toString('hex');
  shareTokens.set(token, { shareId, socketId, isOwner: !!isOwner });
  return token;
}

function revokeGuestTokens(shareId) {
  for (const [token, t] of shareTokens) {
    if (t.shareId === shareId && !t.isOwner) shareTokens.delete(token);
  }
}

function publicShareInfo(share) {
  return {
    id: share.id,
    name: share.name,
    owner: share.ownerNick,
    locked: !!share.passwordHash,
    writable: share.writable,
    createdAt: share.createdAt
  };
}

function broadcastShares() {
  io.emit('shares_update', Array.from(shares.values()).map(publicShareInfo));
}

function myShareOf(socketId) {
  for (const share of shares.values()) {
    if (share.ownerId === socketId) return share;
  }
  return null;
}

// 共享路径净化：防路径穿越/非法字符，返回相对路径串；非法返回 null
function sanitizeSharePath(raw) {
  const p = String(raw == null ? '' : raw);
  if (p.length > 512) return null;
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    if (/[\\<>:"|?*\x00-\x1f]/.test(seg)) return null;
    out.push(seg);
    if (out.length > 20) return null;
  }
  return out.join('/');
}

// 校验 :id 共享存在且 token 有权限访问
function authShare(req) {
  const share = shares.get(String(req.params.id || ''));
  if (!share) return { status: 404, error: '共享不存在或已关闭' };
  const t = shareTokens.get(String(req.query.token || ''));
  if (!t || t.shareId !== share.id) {
    return { status: 401, error: '未授权，请先进入共享', needAuth: true };
  }
  return { share, tokenInfo: t };
}

// 校验 push/pull 来自共享者本人
function authOwner(req, share) {
  const t = shareTokens.get(String(req.query.token || ''));
  return t && t.shareId === share.id && t.isOwner;
}

function failTransfer(transferId, statusCode, message) {
  const t = pendingTransfers.get(transferId);
  if (!t) return;
  clearTimeout(t.timer);
  pendingTransfers.delete(transferId);
  const target = t.res;
  if (target && !target.headersSent) {
    target.status(statusCode).json({ ok: false, error: message });
  } else if (target) {
    target.destroy();
  }
  if (t.req && !t.req.readableEnded) t.req.destroy();
}

function removeShare(shareId) {
  if (!shares.has(shareId)) return;
  shares.delete(shareId);
  for (const [token, t] of shareTokens) {
    if (t.shareId === shareId) shareTokens.delete(token);
  }
  for (const [tid, t] of pendingTransfers) {
    if (t.shareId === shareId) failTransfer(tid, 410, '共享已关闭');
  }
  broadcastShares();
}

// ---------- 浏览共享目录 ----------
app.get('/api/share/:id/list', async (req, res) => {
  const a = authShare(req);
  if (a.error) return res.status(a.status).json({ ok: false, error: a.error, needAuth: !!a.needAuth });
  const p = sanitizeSharePath(req.query.path);
  if (p === null) return res.status(400).json({ ok: false, error: '路径无效' });
  const owner = io.sockets.sockets.get(a.share.ownerId);
  if (!owner) return res.status(502).json({ ok: false, error: '共享者已离线' });
  try {
    const r = await owner.timeout(OWNER_ACK_TIMEOUT).emitWithAck('share_fs', { op: 'list', path: p });
    if (!r || !r.ok) return res.status(502).json({ ok: false, error: (r && r.error) || '共享者无响应' });
    res.json({ ok: true, path: p, entries: r.entries || [] });
  } catch (_) {
    res.status(504).json({ ok: false, error: '共享者响应超时' });
  }
});

// ---------- 下载共享文件（共享者浏览器 → 服务器 → 下载者） ----------
app.get('/api/share/:id/file', (req, res) => {
  const a = authShare(req);
  if (a.error) return res.status(a.status).json({ ok: false, error: a.error, needAuth: !!a.needAuth });
  const p = sanitizeSharePath(req.query.path);
  if (p === null || !p) return res.status(400).json({ ok: false, error: '路径无效' });
  const owner = io.sockets.sockets.get(a.share.ownerId);
  if (!owner) return res.status(502).json({ ok: false, error: '共享者已离线' });

  const transferId = crypto.randomBytes(16).toString('hex');
  const t = {
    kind: 'push', shareId: a.share.id, res, started: false,
    timer: setTimeout(() => failTransfer(transferId, 504, '共享者传输超时'), TRANSFER_START_TIMEOUT)
  };
  pendingTransfers.set(transferId, t);
  // 下载者中途断开且共享者尚未开始推流 → 直接清理
  res.on('close', () => {
    if (!t.started && pendingTransfers.get(transferId) === t) {
      clearTimeout(t.timer);
      pendingTransfers.delete(transferId);
    }
  });

  owner.timeout(OWNER_ACK_TIMEOUT).emit('share_fs', { op: 'read', path: p, transferId }, (err, r) => {
    if (err || !r || !r.ok) {
      failTransfer(transferId, 404, (r && r.error) || '共享者读取文件失败');
    }
    // 读取成功则等待共享者 POST /push 推流（元信息随 push  query 到达）
  });
});

// ---------- 共享者推流（下载数据） ----------
app.post('/api/share/:id/push', (req, res) => {
  const share = shares.get(String(req.params.id || ''));
  if (!share) return res.status(404).json({ ok: false, error: '共享不存在' });
  if (!authOwner(req, share)) return res.status(401).json({ ok: false, error: '无权推流' });
  const transferId = String(req.query.transferId || '');
  const t = pendingTransfers.get(transferId);
  if (!t || t.kind !== 'push' || t.shareId !== share.id) {
    return res.status(409).json({ ok: false, error: '传输不存在或已过期' });
  }
  clearTimeout(t.timer);
  pendingTransfers.delete(transferId);
  t.started = true;

  const dlRes = t.res;
  if (dlRes.destroyed || dlRes.writableEnded) {
    req.destroy();
    return res.status(410).json({ ok: false, error: '下载方已断开' });
  }
  const name = String(req.query.name || 'file').slice(0, 255);
  const size = Number(req.query.size);
  dlRes.setHeader('Content-Type', 'application/octet-stream');
  dlRes.setHeader('Content-Disposition', contentDisposition(name));
  if (Number.isFinite(size) && size >= 0) dlRes.setHeader('Content-Length', size);
  dlRes.setHeader('X-Content-Type-Options', 'nosniff');
  dlRes.on('close', () => { if (!dlRes.writableEnded) req.destroy(); });
  req.on('error', () => dlRes.destroy());
  req.pipe(dlRes);
  req.on('end', () => res.json({ ok: true }));
});

// ---------- 上传文件到共享目录（上传者 → 服务器 → 共享者浏览器写入磁盘） ----------
app.post('/api/share/:id/write', (req, res) => {
  const a = authShare(req);
  if (a.error) return res.status(a.status).json({ ok: false, error: a.error, needAuth: !!a.needAuth });
  if (!a.share.writable) return res.status(403).json({ ok: false, error: '该共享为只读，不允许写入' });
  const p = sanitizeSharePath(req.query.path);
  if (p === null || !p) return res.status(400).json({ ok: false, error: '路径无效' });
  const owner = io.sockets.sockets.get(a.share.ownerId);
  if (!owner) return res.status(502).json({ ok: false, error: '共享者已离线' });

  const transferId = crypto.randomBytes(16).toString('hex');
  const t = {
    kind: 'pull', shareId: a.share.id, req, res, started: false,
    timer: setTimeout(() => failTransfer(transferId, 504, '共享者传输超时'), TRANSFER_START_TIMEOUT)
  };
  pendingTransfers.set(transferId, t);
  req.on('aborted', () => {
    if (pendingTransfers.get(transferId) === t) failTransfer(transferId, 499, '上传方已断开');
  });

  const size = Number(req.headers['content-length']);
  owner.timeout(WRITE_ACK_TIMEOUT).emit('share_fs', {
    op: 'write', path: p, transferId, size: Number.isFinite(size) ? size : null
  }, (err, r) => {
    const tt = pendingTransfers.get(transferId);
    if (tt) {
      clearTimeout(tt.timer);
      pendingTransfers.delete(transferId);
    }
    if (err || !r || !r.ok) {
      if (!res.headersSent) res.status(502).json({ ok: false, error: (r && r.error) || '共享者写入失败' });
    } else if (!res.headersSent) {
      res.json({ ok: true, savedAs: r.savedAs });
    }
  });
});

// ---------- 共享者拉流（上传数据） ----------
app.get('/api/share/:id/pull', (req, res) => {
  const share = shares.get(String(req.params.id || ''));
  if (!share) return res.status(404).json({ ok: false, error: '共享不存在' });
  if (!authOwner(req, share)) return res.status(401).json({ ok: false, error: '无权拉流' });
  const transferId = String(req.query.transferId || '');
  const t = pendingTransfers.get(transferId);
  if (!t || t.kind !== 'pull' || t.shareId !== share.id) {
    return res.status(409).json({ ok: false, error: '传输不存在或已过期' });
  }
  clearTimeout(t.timer);
  t.started = true;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.on('close', () => { if (!t.req.readableEnded) t.req.destroy(); });
  t.req.on('error', () => res.destroy());
  t.req.pipe(res);
});

// ---------- Socket.IO ----------
const onlineUsers = new Map(); // socketId -> nickname

// 多方语音通话房间（WebRTC Mesh）：
// callRooms: roomId -> { ownerId, members:Set<socketId>(已接通), ringing:Set<socketId>(正在振铃) }
// memberRooms: socketId -> roomId（振铃中或通话中，一个用户同时只在一个房间）
const callRooms = new Map();
const memberRooms = new Map();

// ---------- 实时白板状态 ----------
const wbStrokes = []; // {id, authorId, author, color, size, tool, pts:[[x,y]...]}  已完成笔迹历史
let wbTotalPoints = 0;
const WB_MAX_STROKES = 1500;          // 历史笔迹数上限
const WB_MAX_POINTS_PER_STROKE = 5000; // 单笔点数上限
const WB_MAX_TOTAL_POINTS = 200000;    // 历史总点数上限（超出丢最旧）
const WB_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function wbClamp01(v) {
  v = Number(v);
  if (!Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

function wbCleanPoints(ptsRaw, maxCount) {
  const pts = [];
  for (const p of ptsRaw) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const x = wbClamp01(p[0]);
    const y = wbClamp01(p[1]);
    if (x === null || y === null) continue;
    pts.push([Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
    if (pts.length >= maxCount) break;
  }
  return pts;
}

// 校验并净化一条完整笔迹；非法返回 null
function wbSanitizeStroke(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tool = raw.tool === 'eraser' ? 'eraser' : 'pen';
  const color = WB_COLOR_RE.test(raw.color) ? raw.color : '#1f2328';
  let size = Number(raw.size);
  if (!Number.isFinite(size)) size = 4;
  size = Math.min(40, Math.max(1, size));
  const pts = wbCleanPoints(raw.pts, WB_MAX_POINTS_PER_STROKE);
  if (!pts.length) return null;
  return { color, size, tool, pts };
}

function wbTrimHistory() {
  while (wbStrokes.length && (wbStrokes.length > WB_MAX_STROKES || wbTotalPoints > WB_MAX_TOTAL_POINTS)) {
    wbTotalPoints -= wbStrokes.shift().pts.length;
  }
}

// ---------- 白板实时光标状态 ----------
const cursorColors = new Map(); // socketId -> 分配的光标颜色
const wbCursors = new Map();    // socketId -> {x, y}  最后上报的光标位置
const CURSOR_PALETTE = ['#e11d48', '#d97706', '#059669', '#2563eb', '#7c3aed', '#db2777', '#0891b2', '#65a30d'];

// 分配当前使用人数最少的颜色，尽量避免撞色
function assignCursorColor() {
  const counts = new Map(CURSOR_PALETTE.map((c) => [c, 0]));
  for (const c of cursorColors.values()) counts.set(c, (counts.get(c) || 0) + 1);
  let best = CURSOR_PALETTE[0];
  for (const [c, n] of counts) {
    if (n < counts.get(best)) best = c;
  }
  return best;
}

// ---------- 屏幕共享状态（1 名共享者 → 多名观看者，WebRTC Mesh） ----------
let screenShare = null; // { presenterId, presenterName, startedAt, viewers: Set<socketId> }
const SS_MAX_VIEWERS = 8; // Mesh 拓扑下共享者为每个观看者独立编码，限制人数防过载

function endScreenShare(reason) {
  if (!screenShare) return;
  const presenterId = screenShare.presenterId;
  screenShare = null;
  io.emit('ss_ended', { reason, presenterId });
}

function randomNickname() {
  return `用户${Math.floor(1000 + Math.random() * 9000)}`;
}

// 昵称等展示文本禁止控制字符（C0/DEL）
function hasControlChars(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

// ---------- 聊天消息流水（供撤回/引用定位；内存保存，封顶丢最旧） ----------
const chatLog = []; // {id, nickname, senderId, type, text|fileName, timestamp, recalled, ...}
const CHAT_LOG_MAX = 500;
const RECALL_WINDOW = 2 * 60 * 1000; // 撤回时限 2 分钟
let chatMsgSeq = 0;

function nextMsgId() {
  return `m${Date.now().toString(36)}${(chatMsgSeq++).toString(36)}`;
}

function chatLogPush(msg) {
  chatLog.push(msg);
  if (chatLog.length > CHAT_LOG_MAX) chatLog.shift();
  return msg;
}

function chatLogFind(id) {
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if (chatLog[i].id === id) return chatLog[i];
  }
  return null;
}

// 引用快照：文本截断 80 字；文件/图片用占位描述；已撤回消息不可引用
function quoteSnapshot(msg) {
  if (!msg || msg.recalled) return null;
  let text = msg.text || '';
  if (msg.type === 'file') text = `[文件] ${msg.fileName || ''}`;
  else if (msg.type === 'image') text = `[图片] ${msg.fileName || ''}`;
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 80) text = text.slice(0, 80) + '…';
  return { id: msg.id, nickname: msg.nickname, text };
}

// @提及解析：在线昵称最长匹配优先；昵称右侧需为边界（非中英文数字连字符或结尾）
function parseMentions(text) {
  const nicks = Array.from(new Set(onlineUsers.values())).sort((a, b) => b.length - a.length);
  const found = new Set();
  for (const nick of nicks) {
    const needle = '@' + nick;
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      const after = text[idx + needle.length];
      if (after === undefined || !/[\w一-龥-]/.test(after)) {
        found.add(nick);
        break;
      }
      idx += needle.length;
    }
  }
  return Array.from(found);
}

function broadcastMembers() {
  const members = Array.from(onlineUsers.entries()).map(([id, nickname]) => ({ id, nickname }));
  io.emit('members_update', members);
}

io.on('connection', (socket) => {
  let nickname = randomNickname();
  let lastRenameAt = 0;
  let lastCursorRelay = 0;
  onlineUsers.set(socket.id, nickname);
  cursorColors.set(socket.id, assignCursorColor());

  // 通知本人（id 用于 WebRTC 通话信令定位）；附带最近历史消息
  let history = [];
  try { history = store.loadMessages(200, 'main'); } catch (_) { /* 历史不可用 */ }
  socket.emit('welcome', { id: socket.id, nickname, online: onlineUsers.size, history });
  // 推送当前共享列表
  socket.emit('shares_update', Array.from(shares.values()).map(publicShareInfo));
  // 推送当前屏幕共享状态
  socket.emit('ss_state', screenShare
    ? { active: true, presenterId: screenShare.presenterId, presenterName: screenShare.presenterName }
    : { active: false });

  // 广播上线
  io.emit('system_message', {
    type: 'join',
    nickname,
    text: `${nickname} 加入了聊天室`,
    timestamp: Date.now()
  });
  broadcastMembers();

  // 聊天消息（带消息 ID/@提及解析/引用快照，入流水供撤回）
  socket.on('chat_message', (data) => {
    const text = String((data && data.text) || '').trim();
    if (!text || text.length > 5000) return;
    const msg = {
      id: nextMsgId(),
      type: 'text',
      senderId: socket.id,
      nickname,
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
    store.trimMessages('main');
    io.emit('chat_message', msg);
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
    if (msg.nickname !== nickname) return cb({ ok: false, error: '只能撤回自己的消息' });
    if (Date.now() - msg.timestamp > RECALL_WINDOW) return cb({ ok: false, error: '超过 2 分钟，无法撤回' });
    msg.recalled = true;
    store.recallMessage(id);
    io.emit('chat_recall', { id: msg.id, nickname, timestamp: Date.now() });
    cb({ ok: true });
  });

  // ---------- 数据面板（历史/搜索/统计/清空） ----------

  // 搜索历史消息（关键词/昵称/时间范围）
  socket.on('history_search', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    try {
      const results = store.searchMessages({
        keyword: String((data && data.keyword) || '').slice(0, 100) || null,
        nickname: String((data && data.nickname) || '').slice(0, 20) || null,
        from: data && data.from ? Number(data.from) : null,
        to: data && data.to ? Number(data.to) : null,
        room: 'main',
        limit: Math.min(Number((data && data.limit) || 100), 500)
      });
      cb({ ok: true, results });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 数据统计
  socket.on('history_stats', (cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    try {
      cb({ ok: true, ...store.stats('main') });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 清空历史（消息；可选连带白板）
  socket.on('history_clear', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    try {
      const r = store.clearHistory('main', !!(data && data.includeStrokes));
      chatLog.length = 0;
      if (data && data.includeStrokes) {
        wbStrokes.length = 0;
        wbTotalPoints = 0;
        io.emit('wb_clear', { author: nickname });
      }
      cb({ ok: true, ...r });
      io.emit('system_message', {
        type: 'clear',
        nickname,
        text: `${nickname} 清空了聊天历史${data && data.includeStrokes ? '与白板' : ''}`,
        timestamp: Date.now()
      });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 修改昵称（全站唯一、1~20 字符、2 秒限速；silent 时不广播系统消息）
  socket.on('set_nickname', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const name = String((data && data.name) || '').trim();
    if (!name || name.length > 20) return cb({ ok: false, error: '昵称需为 1~20 个字符' });
    if (hasControlChars(name)) return cb({ ok: false, error: '昵称包含非法字符' });
    if (name === nickname) return cb({ ok: true, nickname: name });
    const now = Date.now();
    if (now - lastRenameAt < 2000) return cb({ ok: false, error: '修改太频繁，请稍后再试' });
    for (const [id, nick] of onlineUsers) {
      if (id !== socket.id && nick === name) return cb({ ok: false, error: '昵称已被他人使用' });
    }
    lastRenameAt = now;
    const old = nickname;
    nickname = name;
    onlineUsers.set(socket.id, name);
    // 同步其共享的展示昵称
    const share = myShareOf(socket.id);
    if (share) {
      share.ownerNick = name;
      broadcastShares();
    }
    broadcastMembers();
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

  // ---------- 多方语音通话信令（WebRTC Mesh 房间模型） ----------
  // 1:1 是 targets=[1人] 的特例；身份一律以发送者 socket.id 为准，客户端无法伪造

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

  // 发起呼叫：targets 支持多个；逐个过滤在线/空闲
  socket.on('call_user', (data) => {
    if (memberRooms.has(socket.id)) {
      return socket.emit('call_failed', { reason: 'busy', error: '你正在通话中' });
    }
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
    const room = { ownerId: socket.id, members: new Set([socket.id]), ringing: new Set() };
    for (const t of targets) room.ringing.add(t.id);
    callRooms.set(roomId, room);
    memberRooms.set(socket.id, roomId);
    for (const t of targets) memberRooms.set(t.id, roomId); // 振铃目标也标记为占用
    const roster = roomRoster(room);
    for (const t of targets) {
      const s = io.sockets.sockets.get(t.id);
      if (s && s.connected) s.emit('incoming_call', { roomId, fromId: socket.id, fromName: nickname, targets, roster });
    }
    socket.emit('call_ringing', { roomId, targets, busy, offline });
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
      member: { id: socket.id, nickname },
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
      owner.emit('call_rejected', { roomId, memberId: socket.id, memberName: nickname });
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

  // ---------- 实时白板 ----------

  // 起笔：校验样式与首点后广播给其他人
  socket.on('wb_begin', (data) => {
    const id = String((data && data.id) || '').slice(0, 40);
    if (!id) return;
    const s = wbSanitizeStroke({ ...(data || {}), pts: [[data && data.x, data && data.y]] });
    if (!s) return;
    socket.broadcast.emit('wb_begin', {
      id, author: nickname, color: s.color, size: s.size, tool: s.tool,
      x: s.pts[0][0], y: s.pts[0][1]
    });
  });

  // 笔迹点批量中继（不落历史，仅转发）
  socket.on('wb_pts', (data) => {
    const id = String((data && data.id) || '').slice(0, 40);
    if (!id) return;
    const pts = wbCleanPoints((data && data.pts) || [], 300);
    if (!pts.length) return;
    socket.broadcast.emit('wb_pts', { id, pts });
  });

  // 收笔：完整笔迹存历史（authorId 用于撤销），其他人收尾该活动笔迹
  socket.on('wb_end', (data) => {
    const id = String((data && data.id) || '').slice(0, 40);
    if (!id) return;
    const s = wbSanitizeStroke(data);
    if (!s) return;
    const stroke = { id, authorId: socket.id, author: nickname, ...s };
    wbStrokes.push(stroke);
    wbTotalPoints += s.pts.length;
    wbTrimHistory();
    store.insertStroke(stroke);
    socket.broadcast.emit('wb_end', { id, author: nickname });
  });

  // 后加入者拉取全量笔迹与在线光标
  socket.on('wb_join', (cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    // 幂等恢复：把数据库笔迹合并进内存（按 id 去重，补上 authorId 用于撤销）
    if (wbStrokes.length === 0) {
      const saved = store.loadStrokes('main');
      for (const s of saved) {
        wbStrokes.push({ ...s, authorId: null }); // authorId 服务重启后无法还原，撤销仅对本次会话有效
        wbTotalPoints += s.pts.length;
      }
    }
    cb({
      ok: true,
      strokes: wbStrokes.map((s) => ({
        id: s.id, author: s.author, color: s.color, size: s.size, tool: s.tool, pts: s.pts
      })),
      cursors: Array.from(wbCursors.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, p]) => ({
          id,
          nickname: onlineUsers.get(id) || '',
          color: cursorColors.get(id) || '#2563eb',
          x: p.x, y: p.y
        }))
    });
  });

  // 光标位置中继（15ms 限频防刷，广播给其他人）
  socket.on('wb_cursor', (data) => {
    const x = wbClamp01(data && data.x);
    const y = wbClamp01(data && data.y);
    if (x === null || y === null) return;
    const now = Date.now();
    if (now - lastCursorRelay < 15) return;
    lastCursorRelay = now;
    wbCursors.set(socket.id, { x, y });
    socket.broadcast.emit('wb_cursor', {
      id: socket.id, nickname, color: cursorColors.get(socket.id), x, y
    });
  });

  // 主动离开白板/移出画布 → 摘除光标
  socket.on('wb_cursor_leave', () => {
    if (wbCursors.delete(socket.id)) {
      socket.broadcast.emit('wb_cursor_leave', { id: socket.id });
    }
  });

  // 撤销自己的最后一笔
  socket.on('wb_undo', () => {
    for (let i = wbStrokes.length - 1; i >= 0; i--) {
      if (wbStrokes[i].authorId === socket.id) {
        const [removed] = wbStrokes.splice(i, 1);
        wbTotalPoints -= removed.pts.length;
        store.removeStrokeByAuthor(socket.id);
        io.emit('wb_remove', { id: removed.id, author: nickname });
        return;
      }
    }
  });

  // 清空画布（所有人同步）
  socket.on('wb_clear', () => {
    wbStrokes.length = 0;
    wbTotalPoints = 0;
    store.clearStrokes('main');
    io.emit('wb_clear', { author: nickname });
  });

  // ---------- 屏幕共享（信令转发；媒体流 P2P 直连不经过服务器） ----------

  // 开始共享（全站同时只允许一名共享者）
  socket.on('ss_start', (data, cb) => {
    // 兼容 emit(event, ack) 与 emit(event, data, ack) 两种调用
    if (typeof data === 'function') { cb = data; }
    cb = typeof cb === 'function' ? cb : () => {};
    if (screenShare) {
      return cb({ ok: false, error: `${screenShare.presenterName} 正在共享屏幕` });
    }
    screenShare = {
      presenterId: socket.id,
      presenterName: nickname,
      startedAt: Date.now(),
      viewers: new Set()
    };
    io.emit('ss_started', { presenterId: socket.id, presenterName: nickname });
    io.emit('system_message', {
      type: 'screen', nickname,
      text: `${nickname} 开始了屏幕共享`,
      timestamp: Date.now()
    });
    cb({ ok: true });
  });

  // 停止共享（仅共享者本人）
  socket.on('ss_stop', () => {
    if (screenShare && screenShare.presenterId === socket.id) {
      io.emit('system_message', {
        type: 'screen', nickname,
        text: `${nickname} 结束了屏幕共享`,
        timestamp: Date.now()
      });
      endScreenShare('stop');
    }
  });

  // 观看共享
  socket.on('ss_watch', (data, cb) => {
    if (typeof data === 'function') { cb = data; }
    cb = typeof cb === 'function' ? cb : () => {};
    if (!screenShare) return cb({ ok: false, error: '当前没有人共享屏幕' });
    if (screenShare.presenterId === socket.id) return cb({ ok: false, error: '你是共享者，无需观看' });
    if (screenShare.viewers.has(socket.id)) {
      // 幂等：重复观看直接成功（不重复通知共享者）
      return cb({ ok: true, presenterId: screenShare.presenterId, presenterName: screenShare.presenterName });
    }
    if (screenShare.viewers.size >= SS_MAX_VIEWERS) return cb({ ok: false, error: '观看人数已满' });
    screenShare.viewers.add(socket.id);
    const presenter = io.sockets.sockets.get(screenShare.presenterId);
    if (presenter) presenter.emit('ss_viewer_joined', { viewerId: socket.id, viewerName: nickname });
    cb({ ok: true, presenterId: screenShare.presenterId, presenterName: screenShare.presenterName });
  });

  // 退出观看
  socket.on('ss_unwatch', () => {
    if (screenShare && screenShare.viewers.delete(socket.id)) {
      const presenter = io.sockets.sockets.get(screenShare.presenterId);
      if (presenter) presenter.emit('ss_viewer_left', { viewerId: socket.id });
    }
  });

  // SDP / ICE 转发（角色校验：offer 只能来自共享者，answer 只能发给共享者，ICE 仅限共享者-观看者对）
  socket.on('ss_offer', (data) => {
    if (!screenShare || screenShare.presenterId !== socket.id) return;
    const toId = String((data && data.toId) || '');
    if (!screenShare.viewers.has(toId)) return;
    const target = io.sockets.sockets.get(toId);
    if (target && target.connected) target.emit('ss_offer', { fromId: socket.id, sdp: data && data.sdp });
  });
  socket.on('ss_answer', (data) => {
    if (!screenShare) return;
    const toId = String((data && data.toId) || '');
    if (toId !== screenShare.presenterId || !screenShare.viewers.has(socket.id)) return;
    const target = io.sockets.sockets.get(toId);
    if (target && target.connected) target.emit('ss_answer', { fromId: socket.id, sdp: data && data.sdp });
  });
  socket.on('ss_ice', (data) => {
    if (!screenShare) return;
    const toId = String((data && data.toId) || '');
    const isPair = (socket.id === screenShare.presenterId && screenShare.viewers.has(toId)) ||
                   (toId === screenShare.presenterId && screenShare.viewers.has(socket.id));
    if (!isPair) return;
    const target = io.sockets.sockets.get(toId);
    if (target && target.connected) target.emit('ss_ice', { fromId: socket.id, candidate: data && data.candidate });
  });

  // ---------- 文件夹共享 ----------

  // 注册共享（每人同时只能共享一个文件夹）
  socket.on('share_register', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    if (myShareOf(socket.id)) return cb({ ok: false, error: '你已有共享中的文件夹，请先取消' });
    const name = (String((data && data.name) || '').trim() || '未命名共享').slice(0, 50);
    const password = data && typeof data.password === 'string' && data.password ? data.password : null;
    const id = crypto.randomBytes(8).toString('hex');
    const salt = crypto.randomBytes(8).toString('hex');
    const canWrite = !!(data && data.writable);
    shares.set(id, {
      id, name, ownerId: socket.id, ownerNick: nickname,
      salt, passwordHash: password ? hashPassword(password, salt) : null,
      canWrite, writable: canWrite, createdAt: Date.now()
    });
    broadcastShares();
    io.emit('system_message', {
      type: 'share', nickname,
      text: `${nickname} 共享了文件夹「${name}」`,
      timestamp: Date.now()
    });
    cb({ ok: true, shareId: id, token: issueToken(id, socket.id, true) });
  });

  // 修改共享（名称/密码/可写）。password: undefined 不变；null 取消密码；字符串 重设密码
  socket.on('share_update', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const share = shares.get(String((data && data.shareId) || ''));
    if (!share || share.ownerId !== socket.id) return cb({ ok: false, error: '无权修改该共享' });
    if (typeof data.name === 'string' && data.name.trim()) {
      share.name = data.name.trim().slice(0, 50);
    }
    if (data.password === null) {
      share.passwordHash = null;
      revokeGuestTokens(share.id);
    } else if (typeof data.password === 'string' && data.password) {
      share.salt = crypto.randomBytes(8).toString('hex');
      share.passwordHash = hashPassword(data.password, share.salt);
      revokeGuestTokens(share.id);
    }
    if (typeof data.writable === 'boolean') {
      share.writable = data.writable && share.canWrite;
    }
    broadcastShares();
    cb({ ok: true, share: publicShareInfo(share) });
  });

  // 取消共享
  socket.on('share_unregister', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const share = shares.get(String((data && data.shareId) || ''));
    if (!share || share.ownerId !== socket.id) return cb({ ok: false, error: '无权操作该共享' });
    removeShare(share.id);
    io.emit('system_message', {
      type: 'share', nickname,
      text: `${nickname} 关闭了共享「${share.name}」`,
      timestamp: Date.now()
    });
    cb({ ok: true });
  });

  // 进入共享（校验密码，签发访问 token）
  socket.on('share_enter', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const share = shares.get(String((data && data.shareId) || ''));
    if (!share) return cb({ ok: false, error: '共享不存在或已关闭' });
    if (share.ownerId === socket.id || !share.passwordHash) {
      return cb({
        ok: true,
        token: issueToken(share.id, socket.id, share.ownerId === socket.id),
        share: publicShareInfo(share)
      });
    }
    const pw = String((data && data.password) || '');
    if (!pw) return cb({ ok: false, needPassword: true, error: '该共享需要密码' });
    const h = Buffer.from(hashPassword(pw, share.salt), 'utf8');
    const ref = Buffer.from(share.passwordHash, 'utf8');
    if (h.length !== ref.length || !crypto.timingSafeEqual(h, ref)) {
      return cb({ ok: false, needPassword: true, error: '密码错误' });
    }
    cb({ ok: true, token: issueToken(share.id, socket.id, false), share: publicShareInfo(share) });
  });

  // 断线
  socket.on('disconnect', () => {
    // 通话中/振铃中离线 → 离开房间并通知他人
    handleMemberLeave(socket.id, 'offline');
    // 屏幕共享清理：共享者离线 → 全员结束；观看者离线 → 通知共享者
    if (screenShare) {
      if (screenShare.presenterId === socket.id) {
        io.emit('system_message', {
          type: 'screen', nickname,
          text: `${nickname} 的屏幕共享已结束`,
          timestamp: Date.now()
        });
        endScreenShare('offline');
      } else if (screenShare.viewers.delete(socket.id)) {
        const presenter = io.sockets.sockets.get(screenShare.presenterId);
        if (presenter) presenter.emit('ss_viewer_left', { viewerId: socket.id });
      }
    }
    onlineUsers.delete(socket.id);
    // 清理光标状态并通知他人移除
    cursorColors.delete(socket.id);
    if (wbCursors.delete(socket.id)) {
      io.emit('wb_cursor_leave', { id: socket.id });
    }
    // 清理该连接的所有 token
    for (const [token, t] of shareTokens) {
      if (t.socketId === socket.id) shareTokens.delete(token);
    }
    // 关闭其共享
    const share = myShareOf(socket.id);
    if (share) {
      removeShare(share.id);
      io.emit('system_message', {
        type: 'share', nickname,
        text: `${nickname} 的共享「${share.name}」已离线`,
        timestamp: Date.now()
      });
    }
    io.emit('system_message', {
      type: 'leave',
      nickname,
      text: `${nickname} 离开了聊天室`,
      timestamp: Date.now()
    });
    broadcastMembers();
  });
});

// ---------- 局域网 IP 获取 ----------
function getLanIPs() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // 兼容 IPv4 字符串与数字格式
      const family = typeof net.family === 'string' ? net.family : `IPv${net.family}`;
      if (family === 'IPv4' && !net.internal) {
        result.push({ name, address: net.address });
      }
    }
  }
  return result;
}

// 数据持久化：启动时自动建库（data/chat.db），失败不阻塞服务
try {
  store.init();
  console.log('  数据持久化: 已连接 SQLite (' + store.DB_FILE + ')');
} catch (e) {
  console.warn('  数据持久化: SQLite 初始化失败，历史功能不可用 —', e.message);
}

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
