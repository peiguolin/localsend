/* 上传秒传（内容 hash 去重）集成测试：
 * - 分片上传带 sha256 → complete 校验通过（完整性）
 * - 相同内容再次 init → 返回 dedup:true（不传分片）
 * - complete dedup 分支 → 复用已有存储文件，消息正常广播/入库/可下载
 * - 单文件 /upload 上传相同内容 → 磁盘上仍只有 1 份文件（hash 命中复用）
 * - 两次消息的 storedName 相同，磁盘文件数 = 1
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { io } = require('socket.io-client');

const PORT = 3144;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-dedup.db');
const UPLOAD_DIR = path.join(__dirname, 'dedup-uploads');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_UPLOAD_DIR: UPLOAD_DIR, LOCALSEND_LOCAL_ADDRS: '10.255.255.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

function connectSocket(cid) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, {
      rejectUnauthorized: false, transports: ['websocket'], reconnection: false,
      auth: { clientId: cid }
    });
    s.once('welcome', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const postJson = (url, data) => fetch(`${BASE}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
}).then((r) => r.json().catch(() => ({ ok: false, error: '解析失败' })));

// 分片上传一个文件（不走 dedup 快路径时逐片传）
async function chunkedUpload(fileBuf, fileName, sha256, opts) {
  const CHUNK = 2 * 1024 * 1024;
  const totalChunks = Math.ceil(fileBuf.length / CHUNK);
  const init = await postJson('/upload/init', {
    fileName: encodeURIComponent(fileName), size: fileBuf.length, lastModified: Date.now(), sha256
  });
  if (!init.ok) return { status: 'init-fail', init };
  if (init.dedup) return { status: 'dedup', init };
  for (let i = 0; i < totalChunks; i++) {
    const part = fileBuf.slice(i * CHUNK, Math.min((i + 1) * CHUNK, fileBuf.length));
    const fd = new FormData();
    fd.append('file', new Blob([part]), 'chunk.part');
    fd.append('uploadId', init.uploadId);
    fd.append('index', String(i));
    const r = await fetch(`${BASE}/upload/chunk`, { method: 'POST', body: fd });
    if (!r.ok) return { status: 'chunk-fail', i };
  }
  const fd2 = new FormData();
  fd2.append('uploadId', init.uploadId);
  fd2.append('originalName', encodeURIComponent(fileName));
  fd2.append('totalChunks', String(totalChunks));
  fd2.append('size', String(fileBuf.length));
  fd2.append('nickname', '秒传测试');
  fd2.append('clientId', 'dedup-c');
  fd2.append('room', 'main');
  if (sha256) fd2.append('sha256', sha256);
  if (opts && opts.caption) fd2.append('text', opts.caption);
  const r = await fetch(`${BASE}/upload/complete`, { method: 'POST', body: fd2 });
  const body = await r.json().catch(() => null);
  return { status: 'complete', statusCode: r.status, body };
}

// 统计磁盘上的正式归档文件数
function countArchivedFiles() {
  let n = 0;
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name !== '.meta.json') n++;
    }
  })(UPLOAD_DIR);
  return n;
}

async function main() {
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  const proc = await startServer();
  let s;
  try {
    s = await connectSocket('dedup-listener');
    const content = Buffer.from('秒传去重测试内容'.repeat(50));
    const sha = sha256Hex(content);

    console.log('【首次分片上传（带 sha256 完整性校验）】');
    const first = await chunkedUpload(content, '原版文件.txt', sha);
    check('首次上传成功', first.status === 'complete' && first.statusCode === 200 && first.body && first.body.ok, JSON.stringify(first));
    const stored1 = first.body.storedName;
    check('首次上传返回 storedName', !!stored1);
    check('磁盘文件数 = 1', countArchivedFiles() === 1, `实际 ${countArchivedFiles()}`);
    check('meta 记录带 sha256', (() => {
      const meta = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, '.meta.json'), 'utf8'));
      return meta[stored1] && meta[stored1].sha256 === sha;
    })());

    console.log('【相同内容再传 → init 直接 dedup】');
    const second = await chunkedUpload(content, '另一个名字.txt', sha);
    check('第二次 init 命中 dedup', second.status === 'dedup' && second.init && second.init.dedup === true, JSON.stringify(second.init));
    check('dedup 返回同一 storedName', second.init.storedName === stored1);

    const fdD = new FormData();
    fdD.append('dedup', '1');
    fdD.append('storedName', stored1);
    fdD.append('originalName', encodeURIComponent('另一个名字.txt'));
    fdD.append('nickname', '秒传测试');
    fdD.append('clientId', 'dedup-c2');
    fdD.append('room', 'main');
    const compD = await fetch(`${BASE}/upload/complete`, { method: 'POST', body: fdD });
    const bodyD = await compD.json().catch(() => null);
    check('dedup complete 成功', compD.status === 200 && bodyD && bodyD.ok, JSON.stringify(bodyD));
    check('dedup 消息复用 storedName', bodyD && bodyD.storedName === stored1);
    check('dedup 消息带独立文件名', bodyD && bodyD.fileName === '另一个名字.txt');
    check('磁盘文件数仍 = 1（零流量复用）', countArchivedFiles() === 1, `实际 ${countArchivedFiles()}`);

    // 去重后下载仍可用
    const dl = await fetch(`${BASE}/download/${encodeURIComponent(stored1)}`);
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    check('去重后下载内容一致', dl.status === 200 && dlBuf.equals(content), `status=${dl.status} len=${dlBuf.length}`);

    console.log('【单文件 /upload 相同内容 → 复用】');
    const fd1 = new FormData();
    fd1.append('file', new Blob([content]), '单文件上传.bin');
    fd1.append('nickname', '秒传测试');
    fd1.append('clientId', 'dedup-c3');
    fd1.append('room', 'main');
    const r1 = await fetch(`${BASE}/upload`, { method: 'POST', body: fd1 });
    const b1 = await r1.json().catch(() => null);
    check('单文件上传成功', r1.status === 200 && b1 && b1.ok, JSON.stringify(b1));
    check('单文件上传复用同一 storedName', b1 && b1.storedName === stored1);
    check('磁盘文件数仍 = 1', countArchivedFiles() === 1, `实际 ${countArchivedFiles()}`);

    // 不同内容 → 新文件
    const other = Buffer.from('完全不同的内容 12345');
    const fd2 = new FormData();
    fd2.append('file', new Blob([other]), '不同内容.txt');
    fd2.append('nickname', '秒传测试');
    fd2.append('clientId', 'dedup-c4');
    fd2.append('room', 'main');
    const r2 = await fetch(`${BASE}/upload`, { method: 'POST', body: fd2 });
    const b2 = await r2.json().catch(() => null);
    check('不同内容上传成功', r2.status === 200 && b2 && b2.ok, JSON.stringify(b2));
    check('不同内容产生新存储文件', b2 && b2.storedName !== stored1);
    check('磁盘文件数 = 2', countArchivedFiles() === 2, `实际 ${countArchivedFiles()}`);
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { s && s.disconnect(); } catch (_) {}
    proc.kill();
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
    try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
