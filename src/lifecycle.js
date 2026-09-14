/* 数据生命周期：文件 TTL / 容量上限 LRU / 孤儿文件 / .tmp 碎片 / 消息保留策略
 * 定期自动清扫（默认每小时），数据面板可手动触发；所有清理只动"过期的"，引用中的数据绝不误删 */
const path = require('path');
const fs = require('fs');
const store = require('../db.js');
const {
  UPLOAD_DIR, TMP_DIR,
  FILE_TTL_DAYS, MAX_UPLOAD_BYTES, MSG_TTL_DAYS, TMP_STALE_MS, SWEEP_INTERVAL, ORPHAN_MIN_AGE_MS
} = require('./config');
const { loadMeta, deleteStoredFile, STORED_NAME_RE } = require('./filemeta');
const { purgeChatLogBefore } = require('./chatlog');

// ---------- 磁盘占用统计（数据面板展示） ----------
function diskUsage() {
  let files = 0;
  let bytes = 0;
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p === TMP_DIR) continue; // .tmp 暂存区单独算，不计入正式文件
        walk(p);
      } else if (e.isFile() && e.name !== '.meta.json') {
        files++;
        try { bytes += fs.statSync(p).size; } catch (_) { /* ignore */ }
      }
    }
  })(UPLOAD_DIR);
  return { files, bytes };
}

// 保留策略配置（面板展示用）
function retentionConfig() {
  return {
    fileTtlDays: FILE_TTL_DAYS,
    maxUploadMB: MAX_UPLOAD_BYTES > 0 ? Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) : 0,
    msgTtlDays: MSG_TTL_DAYS,
    sweepIntervalMin: Math.round(SWEEP_INTERVAL / 60000)
  };
}

// ---------- 文件清扫：TTL → LRU 容量 → 孤儿 → .tmp 碎片 ----------
function sweepFiles(now = Date.now()) {
  const report = { ttlDeleted: 0, lruDeleted: 0, orphansDeleted: 0, tmpDirsDeleted: 0, bytesFreed: 0 };
  const meta = loadMeta();
  const ttlMs = FILE_TTL_DAYS > 0 ? FILE_TTL_DAYS * 24 * 60 * 60 * 1000 : 0;

  const free = (storedName, size) => {
    if (deleteStoredFile(storedName)) {
      report.bytesFreed += Number(size) || 0;
      return true;
    }
    return false;
  };

  // 1) TTL：超过保留期的文件（其消息仍保留，下载时提示文件不存在——与微信"文件已过期"同语义）
  if (ttlMs > 0) {
    for (const [storedName, info] of Object.entries(meta)) {
      const uploadedAt = Number(info && info.uploadedAt) || 0;
      if (uploadedAt && uploadedAt < now - ttlMs) {
        if (free(storedName, info.size)) report.ttlDeleted++;
        delete meta[storedName];
      }
    }
  }

  // 2) LRU 容量上限：超出后按上传时间从最旧开始删
  if (MAX_UPLOAD_BYTES > 0) {
    const alive = Object.entries(meta)
      .map(([storedName, info]) => ({ storedName, uploadedAt: Number(info.uploadedAt) || 0, size: Number(info.size) || 0 }))
      .sort((a, b) => a.uploadedAt - b.uploadedAt);
    let total = alive.reduce((s, x) => s + x.size, 0);
    for (const x of alive) {
      if (total <= MAX_UPLOAD_BYTES) break;
      if (free(x.storedName, x.size)) {
        report.lruDeleted++;
        total -= x.size;
      }
    }
  }

  // 3) 孤儿文件：磁盘上存在但 meta 与 DB 均无记录（meta 丢失/手动放入/历史残留）
  let referenced = new Set();
  try { referenced = store.listReferencedStoredNames(); } catch (_) { /* DB 不可用时保守不删孤儿 */ }
  const metaNow = loadMeta();
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p === TMP_DIR) continue;
        walk(p);
      } else if (e.isFile() && STORED_NAME_RE.test(e.name)) {
        if (e.name in metaNow || referenced.has(e.name)) continue;
        // 至少存在 ORPHAN_MIN_AGE_MS 才删，防误删正在上传中的文件
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch (_) { continue; }
        if (now - mtime < ORPHAN_MIN_AGE_MS) continue;
        try {
          const sz = fs.statSync(p).size;
          fs.unlinkSync(p);
          report.orphansDeleted++;
          report.bytesFreed += sz;
        } catch (_) { /* ignore */ }
      }
    }
  })(UPLOAD_DIR);

  // 4) .tmp 碎片：未完成分片目录过期即删
  try {
    for (const name of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, name);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory() && now - st.mtimeMs > TMP_STALE_MS) {
        fs.rmSync(p, { recursive: true, force: true });
        report.tmpDirsDeleted++;
      }
    }
  } catch (_) { /* .tmp 不存在则跳过 */ }

  return report;
}

// ---------- 消息保留策略：过期消息清理（文件随后由孤儿/TTL 清扫跟进） ----------
function sweepMessages(now = Date.now()) {
  if (MSG_TTL_DAYS <= 0) return { messages: 0 };
  const cutoff = now - MSG_TTL_DAYS * 24 * 60 * 60 * 1000;
  let r = { messages: 0 };
  try {
    r = store.trimMessagesByAge(cutoff);
  } catch (_) { /* DB 不可用 */ }
  purgeChatLogBefore(cutoff);
  return r;
}

function sweepAll(now = Date.now()) {
  return { messages: sweepMessages(now), files: sweepFiles(now) };
}

// 启动定期清扫（每小时一次；unref 不阻碍进程退出）并立即清扫一次
function startScheduler() {
  try {
    const first = sweepAll();
    const f = first.files;
    if (f.ttlDeleted || f.lruDeleted || f.orphansDeleted || f.tmpDirsDeleted || first.messages.messages) {
      console.log(`  生命周期清扫: 过期文件 ${f.ttlDeleted} + LRU ${f.lruDeleted} + 孤儿 ${f.orphansDeleted} + 碎片 ${f.tmpDirsDeleted} + 过期消息 ${first.messages.messages}`);
    }
  } catch (e) {
    console.warn('  生命周期清扫失败:', e.message);
  }
  const timer = setInterval(() => {
    try { sweepAll(); } catch (_) { /* 单次失败下轮再来 */ }
  }, SWEEP_INTERVAL);
  timer.unref();
  return timer;
}

module.exports = { diskUsage, retentionConfig, sweepFiles, sweepMessages, sweepAll, startScheduler };
