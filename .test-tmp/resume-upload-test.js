/* 断点续传 + 分类归档集成测试：
 * - 分片上传：文件切成 CHUNK_SIZE 分片，模拟"只传一半 → 中断 → 重新 init → 续传剩余"
 * - 归档落位：uploads/<类型>/<YYYYMMDD>/<存储名>
 * - 下载取回：/download/<存储名> 按 meta.relPath 定位并还原原文件名
 * - 图片分片上传后 /images 预览可用
 * - 普通 /upload 小文件也按类型/日期归档
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { io } = require('socket.io-client');

const PORT = 3105;
const BASE = `https://127.0.0.1:${PORT}`;
const TEST_DB = path.join(__dirname, 'resume-test.db');
const TEST_UPLOADS = path.join(__dirname, 'resume-uploads');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'] });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function waitEvent(sock, event, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, opts) {
  const r = await fetch(BASE + url, opts);
  return r.json();
}

async function postInit(fileName, size, lastModified) {
  return fetchJson('/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: encodeURIComponent(fileName), size, lastModified })
  });
}

async function postChunk(uploadId, index, buf) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'chunk.part');
  fd.append('uploadId', uploadId);
  fd.append('index', String(index));
  const r = await fetch(BASE + '/upload/chunk', { method: 'POST', body: fd });
  return r.json();
}

async function postComplete(uploadId, originalName, size, totalChunks, clientId) {
  const fd = new FormData();
  fd.append('uploadId', uploadId);
  fd.append('originalName', encodeURIComponent(originalName));
  fd.append('totalChunks', String(totalChunks));
  fd.append('size', String(size));
  fd.append('nickname', '测试员');
  fd.append('clientId', clientId || 'c-test');
  const r = await fetch(BASE + '/upload/complete', { method: 'POST', body: fd });
  return r.json();
}

function startServer() {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      LOCALSEND_DB_FILE: TEST_DB,
      LOCALSEND_UPLOAD_DIR: TEST_UPLOADS
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

// 递归列出测试上传目录里的文件（相对路径）
function listUploadFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, prefix + e.name + '/');
      else out.push(prefix + e.name);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

async function main() {
  // 清掉残留
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  fs.rmSync(TEST_UPLOADS, { recursive: true, force: true });

  let serverProc = await startServer();
  const sock = await connectSocket();
  await sleep(300);

  try {
    console.log('【分片上传 + 断点续传】');
    // 构造 5.5MB 随机数据 → 3 片（2MB×2 + 1.5MB）
    const fileData = crypto.randomBytes(Math.floor(5.5 * 1024 * 1024));
    const fname = '报告.txt';
    const fsize = fileData.length;
    const lastMod = 1700000000000;
    const expectedChunks = Math.ceil(fsize / (2 * 1024 * 1024));
    check('分片数计算正确', expectedChunks === 3, `期望 3 片，实际 ${expectedChunks}`);

    const init1 = await postInit(fname, fsize, lastMod);
    check('init 返回 uploadId + totalChunks', init1.ok && init1.uploadId && init1.totalChunks === 3);
    const uploadId = init1.uploadId;

    // 模拟只传第 0、1 片就"断网"
    await postChunk(uploadId, 0, fileData.slice(0, 2 * 1024 * 1024));
    await postChunk(uploadId, 1, fileData.slice(2 * 1024 * 1024, 4 * 1024 * 1024));
    const status1 = await postInit(fname, fsize, lastMod);
    check('重开 init 返回已收分片 [0,1]', status1.ok && JSON.stringify(status1.received) === '[0,1]', JSON.stringify(status1.received));

    // 续传：只传第 2 片（最后一片），其余跳过
    await postChunk(uploadId, 2, fileData.slice(4 * 1024 * 1024));

    // 监听聊天广播
    const msgP = waitEvent(sock.s, 'chat_message');
    const comp = await postComplete(uploadId, fname, fsize, 3, 'c-resume');
    check('complete 成功', comp.ok === true, comp.error);
    const msg = await msgP;
    check('合并后广播聊天消息', msg && msg.type === 'file' && msg.fileName === fname);

    console.log('【分类 + 日期归档】');
    const dateDir = dateDirName();
    const files = listUploadFiles(TEST_UPLOADS);
    const relPath = `text/${dateDir}/${comp.storedName}`;
    check('归档到 text/<日期>/ 下', files.includes(relPath), `实际文件: ${files.join(', ')}`);
    check('tmp 分片已清理', !files.some((f) => f.includes('.tmp')));

    console.log('【下载取回验证】');
    const dl = await fetch(BASE + '/download/' + comp.storedName);
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    check('下载状态 200', dl.status === 200);
    check('下载内容与上传一致', dlBuf.length === fsize && dlBuf.equals(fileData), `len=${dlBuf.length} vs ${fsize}`);
    const cd = dl.headers.get('content-disposition') || '';
    check('下载还原中文文件名', decodeURIComponent(cd.split("filename*=UTF-8''")[1] || '') === fname);

    console.log('【普通 /upload 小文件也分类归档】');
    const smallFd = new FormData();
    smallFd.append('file', new Blob([Buffer.from('hello pdf content')]), '说明.pdf');
    smallFd.append('nickname', '测试员');
    smallFd.append('clientId', 'c-small');
    const smallRes = await fetch(BASE + '/upload', { method: 'POST', body: smallFd }).then((r) => r.json());
    check('小文件上传成功', smallRes.ok === true);
    const files2 = listUploadFiles(TEST_UPLOADS);
    check('pdf 归档到 document/<日期>/', files2.includes(`document/${dateDir}/${smallRes.storedName}`), files2.join(', '));

    console.log('【图片分片上传后预览可用】');
    const imgData = Buffer.from(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]
    );
    const iInit = await postInit('截图.png', imgData.length, 1700000000001);
    await postChunk(iInit.uploadId, 0, imgData);
    const iComp = await postComplete(iInit.uploadId, '截图.png', imgData.length, 1, 'c-img');
    check('图片分片上传完成', iComp.ok === true && iComp.type === 'image');
    const imgResp = await fetch(BASE + '/images/' + iComp.storedName);
    check('图片预览可访问', imgResp.status === 200 && (imgResp.headers.get('content-type') || '').includes('image/png'));
    const files3 = listUploadFiles(TEST_UPLOADS);
    check('png 归档到 image/<日期>/', files3.includes(`image/${dateDir}/${iComp.storedName}`));

    console.log('【分片不完整 → complete 拒绝】');
    const f2 = '未完成.zip';
    const f2data = crypto.randomBytes(3 * 1024 * 1024);
    const i2 = await postInit(f2, f2data.length, 1700000000002);
    await postChunk(i2.uploadId, 0, f2data.slice(0, 2 * 1024 * 1024));
    const c2 = await postComplete(i2.uploadId, f2, f2data.length, 2, 'c-incomplete');
    check('分片缺失时 complete 返回错误', c2.ok === false && /分片不完整/.test(c2.error), c2.error);

    sock.s.disconnect();
    await sleep(300);
  } finally {
    serverProc.kill();
    await sleep(400);
  }

  // 清理
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
  fs.rmSync(TEST_UPLOADS, { recursive: true, force: true });

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

function dateDirName() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
