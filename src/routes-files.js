/* 文件相关 HTTP 路由：单文件上传、分片断点续传、下载、图片预览、数据导出 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const store = require('../db.js');
const {
  MAX_FILE_SIZE, CHUNK_SIZE, TMP_DIR,
  fileCategory, dateDirName, ensureArchiveDir
} = require('./config');
const { decodeOriginalName } = require('./util');
const { saveMeta, getOriginalName, detectImageMime, STORED_NAME_RE, resolveStoredFile } = require('./filemeta');
const { nextMsgId, chatLogPush } = require('./chatlog');
const { canSendToRoom } = require('./rt-rooms');
const { isLocalAddr } = require('./util');

function registerRoutes(app, io) {
  // ---------- 文件上传（multer，按类型/日期归档） ----------
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      // 还原中文原始文件名，存入 file.decodedName 供后续展示与元数据记录
      file.decodedName = decodeOriginalName(file.originalname);
      const category = fileCategory(file.decodedName);
      const dateDir = dateDirName();
      const dir = ensureArchiveDir(category, dateDir);
      // 记录归档相对路径（相对 UPLOAD_DIR），供下载/预览定位
      file.relPath = path.join(category, dateDir);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
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
    // req.file.relPath 是归档目录（如 text/20260911），必须拼上文件名，否则下载解析不到文件
    const relPath = req.file.relPath ? path.join(req.file.relPath, storedName) : storedName;

    // 记录原始文件名 + 归档相对路径，供下载时还原 Content-Disposition / 定位文件
    saveMeta(storedName, originalName, size, relPath);

    const nickname = (req.body && req.body.nickname) || '匿名';
    const clientId = String((req.body && req.body.clientId) || '');
    const room = String((req.body && req.body.room) || 'main');
    if (!canSendToRoom(room, clientId)) {
      return res.status(403).json({ ok: false, error: '你不在该房间中，无法发送' });
    }
    const base = { id: nextMsgId(), nickname, clientId, room, fileName: originalName, storedName, size, downloadUrl, timestamp: Date.now() };

    // 图片文件：广播 type:'image' 并带上预览地址，前端直接渲染在线预览
    const mime = detectImageMime(storedName, req.file.path);
    if (mime) {
      const imageUrl = `/images/${encodeURIComponent(storedName)}`;
      const msg = { ...base, type: 'image', imageUrl };
      chatLogPush(msg);
      store.insertMessage(msg);
      io.to(room).emit('chat_message', msg);
      return res.json({ ok: true, ...base, type: 'image', imageUrl });
    }

    // 其余文件保持原文件卡片行为
    const msg = { ...base, type: 'file' };
    chatLogPush(msg);
    store.insertMessage(msg);
    io.to(room).emit('chat_message', msg);
    res.json({ ok: true, ...base, type: 'file' });
  });

  // ============================================================
  //  断点续传（分片上传）
  //  文件按 CHUNK_SIZE 切片 → .tmp/<uploadId>/<index>.part 暂存
  //  uploadId 由「文件名+大小+lastModified」哈希生成，同一文件再次上传自动续传
  // ============================================================

  const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CHUNK_SIZE + 64 * 1024 } });

  // fileKey：同一文件（同名+同大小+同修改时间）幂等标识
  function uploadFileKey(fileName, size, lastModified) {
    return crypto.createHash('md5').update(`${fileName}|${size}|${lastModified}`).digest('hex');
  }

  // 扫描 .tmp/<uploadId> 已收到的分片序号
  function listReceivedChunks(uploadId) {
    const dir = path.join(TMP_DIR, uploadId);
    try {
      return fs.readdirSync(dir)
        .filter((f) => /^\d+\.part$/.test(f))
        .map((f) => Number(f.replace('.part', '')))
        .sort((a, b) => a - b);
    } catch (_) {
      return [];
    }
  }

  // 校验 uploadId 合法性（仅十六进制，防路径穿越）
  function validUploadId(id) {
    return /^[a-f0-9]{32}$/.test(String(id || ''));
  }

  // 启动：清理上次异常退出的临时分片
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch (_) { /* 忽略 */ }

  // 初始化上传：返回 uploadId + 已收分片（断点续传时前端跳过已收分片）
  app.post('/upload/init', require('express').json({ limit: '1mb' }), (req, res) => {
    let fileName;
    try { fileName = decodeURIComponent(String((req.body && req.body.fileName) || '')); } catch (_) { fileName = String((req.body && req.body.fileName) || ''); }
    const size = Number((req.body && req.body.size) || 0);
    const lastModified = Number((req.body && req.body.lastModified) || 0);
    if (!fileName || size <= 0 || size > MAX_FILE_SIZE) {
      return res.status(400).json({ ok: false, error: '文件参数无效或超过 200MB 限制' });
    }
    const uploadId = uploadFileKey(fileName, size, lastModified);
    fs.mkdirSync(path.join(TMP_DIR, uploadId), { recursive: true });
    res.json({
      ok: true,
      uploadId,
      chunkSize: CHUNK_SIZE,
      totalChunks: Math.ceil(size / CHUNK_SIZE),
      received: listReceivedChunks(uploadId)
    });
  });

  // 上传单个分片（multipart: file + uploadId + index）
  app.post('/upload/chunk', chunkUpload.single('file'), (req, res) => {
    const uploadId = String((req.body && req.body.uploadId) || '');
    const index = Number((req.body && req.body.index));
    if (!validUploadId(uploadId) || !Number.isInteger(index) || index < 0) {
      return res.status(400).json({ ok: false, error: '分片参数无效' });
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ ok: false, error: '未收到分片数据' });
    }
    const dir = path.join(TMP_DIR, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${index}.part`), req.file.buffer);
    res.json({ ok: true, index, received: listReceivedChunks(uploadId) });
  });

  // 查询已收分片（刷新页面/重新选择同一文件时续传）
  app.post('/upload/status', require('express').json({ limit: '1mb' }), (req, res) => {
    const uploadId = String((req.body && req.body.uploadId) || '');
    if (!validUploadId(uploadId)) return res.status(400).json({ ok: false, error: 'uploadId 无效' });
    res.json({ ok: true, uploadId, received: listReceivedChunks(uploadId) });
  });

  // 合并分片 → 按类型/日期归档 → 进入聊天消息流程 → 清理临时分片
  app.post('/upload/complete', multer().none(), (req, res) => {
    try {
      const uploadId = String((req.body && req.body.uploadId) || '');
      let originalNameRaw = String((req.body && req.body.originalName) || '');
      try { originalNameRaw = decodeURIComponent(originalNameRaw); } catch (_) { /* 已是非编码形式 */ }
      const totalChunks = Number((req.body && req.body.totalChunks) || 0);
      const size = Number((req.body && req.body.size) || 0);
      if (!validUploadId(uploadId) || !Number.isInteger(totalChunks) || totalChunks <= 0) {
        return res.status(400).json({ ok: false, error: '合并参数无效' });
      }
      const dir = path.join(TMP_DIR, uploadId);
      const received = listReceivedChunks(uploadId);
      if (received.length !== totalChunks) {
        return res.status(400).json({ ok: false, error: `分片不完整：已收 ${received.length}/${totalChunks}` });
      }

      // 原文件名（前端已 encodeURIComponent，这里还原）与类型/日期归档
      const originalName = originalNameRaw;
      const category = fileCategory(originalName);
      const dateDir = dateDirName();
      const archiveDir = ensureArchiveDir(category, dateDir);

      // 生成存储名：时间戳 + 随机串 + 安全扩展名
      const ext = path.extname(originalName || '').replace(/[^a-zA-Z0-9.]/g, '');
      const safeExt = ext.length > 1 && ext.length <= 10 ? ext : '';
      const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`;
      const finalPath = path.join(archiveDir, storedName);
      const relPath = path.join(category, dateDir, storedName);

      // 按分片序号合并写入最终文件
      const out = fs.createWriteStream(finalPath);
      const chunks = [];
      for (let i = 0; i < totalChunks; i++) {
        const buf = fs.readFileSync(path.join(dir, `${i}.part`));
        if (buf.length === 0) throw new Error(`分片 ${i} 为空`);
        chunks.push(buf);
        // 边读边写，避免一次性占满内存
        if (chunks.length >= 32) {
          for (const c of chunks) out.write(c);
          chunks.length = 0;
        }
      }
      for (const c of chunks) out.write(c);
      out.end();
      out.on('finish', () => {
        // 校验合并后大小（与分片总数 × 理论大小一致即可，不强制等于 size 以兼容最后一片）
        const actualSize = fs.statSync(finalPath).size;
        if (size > 0 && Math.abs(actualSize - size) > CHUNK_SIZE) {
          fs.rmSync(finalPath, { force: true });
          fs.rmSync(dir, { recursive: true, force: true });
          return res.status(400).json({ ok: false, error: '合并后文件大小与预期不符' });
        }

        // 记录元数据 + 进入聊天消息流程
        saveMeta(storedName, originalName, actualSize, relPath);
        const nickname = String((req.body && req.body.nickname) || '匿名');
        const clientId = String((req.body && req.body.clientId) || '');
        const room = String((req.body && req.body.room) || 'main');
        if (!canSendToRoom(room, clientId)) {
          fs.rmSync(finalPath, { force: true });
          fs.rmSync(dir, { recursive: true, force: true });
          return res.status(403).json({ ok: false, error: '你不在该房间中，无法发送' });
        }
        const downloadUrl = `/download/${encodeURIComponent(storedName)}`;
        const base = { id: nextMsgId(), nickname, clientId, room, fileName: originalName, storedName, size: actualSize, downloadUrl, timestamp: Date.now() };

        const mime = detectImageMime(storedName, finalPath);
        if (mime) {
          const imageUrl = `/images/${encodeURIComponent(storedName)}`;
          const msg = { ...base, type: 'image', imageUrl };
          chatLogPush(msg);
          store.insertMessage(msg);
          io.to(room).emit('chat_message', msg);
          fs.rmSync(dir, { recursive: true, force: true });
          return res.json({ ok: true, ...base, type: 'image', imageUrl });
        }

        const msg = { ...base, type: 'file' };
        chatLogPush(msg);
        store.insertMessage(msg);
        io.to(room).emit('chat_message', msg);
        fs.rmSync(dir, { recursive: true, force: true });
        res.json({ ok: true, ...base, type: 'file' });
      });
      out.on('error', (e) => {
        res.status(500).json({ ok: false, error: `合并失败：${e.message}` });
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: `服务器错误：${e.message}` });
    }
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

  // ---------- 数据导出（下载 SQLite 库文件备份；仅宿主机） ----------
  app.get('/data-export', (req, res) => {
    if (!isLocalAddr(req.ip || req.socket.remoteAddress)) {
      return res.status(403).send('仅宿主机可导出数据');
    }
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
}

module.exports = { registerRoutes };
