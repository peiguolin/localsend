/* 文件元数据 / 图片识别 / 存储定位 / 历史消息 URL 装饰 */
const path = require('path');
const fs = require('fs');
const store = require('../db.js');
const { UPLOAD_DIR, META_FILE, IMAGE_MIMES, AUDIO_MIMES } = require('./config');

// ---------- 文件元数据持久化（用于下载时还原原始文件名） ----------
function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

// sha256 → { storedName, size, relPath } 的缓存索引（秒传去重用；saveMeta/deleteMeta 时失效重建）
let hashIndexCache = null;
function buildHashIndex() {
  const idx = new Map();
  const meta = loadMeta();
  for (const [storedName, info] of Object.entries(meta)) {
    if (info && info.sha256) idx.set(String(info.sha256).toLowerCase(), { storedName, size: Number(info.size) || 0 });
  }
  return idx;
}
function findByHash(sha256) {
  const h = String(sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(h)) return null;
  if (!hashIndexCache) hashIndexCache = buildHashIndex();
  return hashIndexCache.get(h) || null;
}

function saveMeta(storedName, originalName, size, relPath, sha256) {
  const db = loadMeta();
  const entry = { originalName, size, uploadedAt: Date.now(), relPath: relPath || storedName };
  if (sha256) entry.sha256 = String(sha256).toLowerCase();
  db[storedName] = entry;
  hashIndexCache = null;
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

// 删除单条元数据记录
function deleteMeta(storedName) {
  const db = loadMeta();
  if (!(storedName in db)) return;
  delete db[storedName];
  hashIndexCache = null;
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(db, null, 2));
  } catch (_) { /* 忽略 */ }
}

// 删除存储文件本体 + 元数据（撤回联动 / 生命周期清扫共用）；返回是否删到了文件
function deleteStoredFile(storedName) {
  let deleted = false;
  try {
    const resolved = resolveStoredFile(storedName);
    if (resolved) {
      fs.unlinkSync(resolved);
      deleted = true;
    }
  } catch (_) { /* 文件删不掉不阻塞（可能已不存在） */ }
  deleteMeta(storedName);
  return deleted;
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

// ---------- 语音/音频识别（扩展名白名单 + 文件头魔数） ----------
function checkAudioMagic(storedPath, ext) {
  try {
    const fd = fs.openSync(storedPath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    switch (ext) {
      case '.webm':
      case '.weba':
        // EBML 头：1A 45 DF A3（WebM 容器，含音频轨道）
        return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
      case '.ogg':
      case '.opus':
        return buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53; // "OggS"
      case '.m4a':
        // ISO BMFF：前 4 字节长度 + "ftyp" + 品牌 M4A（语音录制常见）
        return buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70 &&
               buf[8] === 0x4d && buf[9] === 0x34 && buf[10] === 0x41;
      case '.mp3':
        return (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || // "ID3"
               (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);            // MPEG 帧同步
      case '.wav':
        return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45;
      case '.flac':
        return buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43; // "fLaC"
      case '.aac':
        return buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0; // ADTS 帧同步
      default:
        return false;
    }
  } catch (_) {
    return false;
  }
}

function detectAudioMime(storedName, storedPath) {
  const ext = path.extname(storedName).toLowerCase();
  const mime = AUDIO_MIMES[ext];
  if (!mime) return null;
  return checkAudioMagic(storedPath, ext) ? mime : null;
}

// ---------- 存储文件定位（防路径穿越，供下载/预览共用） ----------
const STORED_NAME_RE = /^[0-9]+-[a-f0-9]{12}(\.[a-zA-Z0-9]{1,10})?$/;

// 根据 meta 记录的相对路径解析真实文件；旧文件（无 relPath 记录）回退到 uploads 根目录
function resolveStoredFile(raw) {
  if (!raw || !STORED_NAME_RE.test(raw)) return null;
  const meta = loadMeta();
  const rel = meta[raw] && meta[raw].relPath;
  const candidates = [];
  if (rel && rel !== raw) {
    candidates.push(rel); // 新格式：relPath 已是完整相对路径（含文件名）
    candidates.push(path.join(rel, raw)); // 旧格式：relPath 只有归档目录，拼上文件名
  }
  candidates.push(raw); // 兼容旧版平铺在 uploads 根目录的文件
  const uploadRoot = path.resolve(UPLOAD_DIR);
  for (const c of candidates) {
    const resolved = path.resolve(UPLOAD_DIR, c);
    if (resolved !== uploadRoot && !resolved.startsWith(uploadRoot + path.sep)) continue;
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

// 给历史/搜索返回的消息补上文件/图片的下载/预览 URL（DB 只存 storedName，URL 由它推导）
// 语音消息（type=file + 音频魔数）额外标 audio=true，前端据此渲染内嵌播放器
function decorateMsgUrls(msg) {
  if (!msg || !msg.storedName) return msg;
  msg.downloadUrl = `/download/${encodeURIComponent(msg.storedName)}`;
  if (msg.type === 'image') msg.imageUrl = `/images/${encodeURIComponent(msg.storedName)}`;
  if (msg.type === 'file' && !msg.audio) {
    const ext = path.extname(msg.storedName || '').toLowerCase();
    if (AUDIO_MIMES[ext]) {
      try {
        const resolved = resolveStoredFile(msg.storedName);
        if (resolved && detectAudioMime(msg.storedName, resolved)) msg.audio = true;
      } catch (_) { /* 识别失败按普通文件处理 */ }
    }
  }
  return msg;
}

// 老消息恢复：早期版本没把 storedName 落库，刷新后历史里的文件/图片消息没有 URL。
// 用「原始文件名 + 上传时间戳」去 meta.json 匹配回 storedName，并回写 DB 一劳永逸。
function restoreStoredNames(msgs) {
  if (!Array.isArray(msgs)) return msgs;
  let meta = null;
  const need = msgs.filter((m) => (m.type === 'image' || m.type === 'file') && !m.storedName && m.fileName);
  if (!need.length) return msgs;
  try { meta = loadMeta(); } catch (_) { meta = {}; }
  const byNameTs = [];
  for (const raw of Object.keys(meta || {})) {
    const e = meta[raw];
    if (e && e.originalName) byNameTs.push({ stored: raw, name: e.originalName, ts: Number(e.uploadedAt) || 0 });
  }
  for (const m of need) {
    // 精确匹配（同名 + 同时间戳）优先，放宽到 ±60s 内同名
    let hit = byNameTs.find((x) => x.name === m.fileName && Math.abs(x.ts - m.timestamp) <= 5000) ||
              byNameTs.find((x) => x.name === m.fileName && Math.abs(x.ts - m.timestamp) <= 60000);
    if (hit) {
      m.storedName = hit.stored;
      try { store.updateMessageStoredName(m.id, hit.stored); } catch (_) { /* 回写失败不阻塞 */ }
      decorateMsgUrls(m);
    }
  }
  return msgs;
}

// 统一处理历史/搜索结果：恢复老消息 storedName + 补 URL
function decorateHistory(msgs) {
  return restoreStoredNames(msgs).map(decorateMsgUrls);
}

module.exports = {
  loadMeta, saveMeta, getOriginalName, deleteMeta, deleteStoredFile, findByHash,
  checkImageMagic, detectImageMime, checkAudioMagic, detectAudioMime,
  STORED_NAME_RE, resolveStoredFile,
  decorateMsgUrls, restoreStoredNames, decorateHistory
};
