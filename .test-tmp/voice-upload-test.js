/* 语音消息（服务端）集成测试：分片上传带 audio=1 → 归档到 audio/、消息标 audio、
 * 魔数识别（不带 audio 标志也能识别）、历史装饰 audio=true、下载可用、单文件上传识别。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3100;
const BASE = `https://127.0.0.1:${PORT}`;
const TMP_UPLOAD = path.join(__dirname, 'test-voice-uploads');
const DB_FILE = path.join(__dirname, 'test-voice.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra !== undefined ? ' — ' + extra : ''}`); }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'] });
    s.on('welcome', (w) => resolve({ s, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function waitMsg(sock, pred, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待消息超时')), timeout);
    const h = (d) => { if (pred(d)) { clearTimeout(t); sock.off('chat_message', h); resolve(d); } };
    sock.on('chat_message', h);
  });
}

function findUnder(root, name) {
  if (!fs.existsSync(root)) return null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { const r = findUnder(p, name); if (r) return r; }
    else if (e.name === name) return p;
  }
  return null;
}

// WebM(EBML) 魔数开头的假音频数据
function webmBytes(len = 64) {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(len, 7)]);
}

async function main() {
  fs.rmSync(TMP_UPLOAD, { recursive: true, force: true });
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + s); } catch (_) { /* ignore */ } }
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_UPLOAD_DIR: TMP_UPLOAD, LOCALSEND_LOCAL_ADDRS: '127.0.0.1,::1,::ffff:127.0.0.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  try {
    const { s, nickname } = await connectSocket();
    const clientId = 'voice-test-client';
    const bytes = webmBytes();
    const fileName = '语音消息-测试.webm';

    console.log('【分片上传语音（audio=1）】');
    const init = await (await fetch(`${BASE}/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, size: bytes.length, lastModified: 1 })
    })).json();
    check('init 成功', init.ok && !!init.uploadId, JSON.stringify(init));
    const fd1 = new FormData();
    fd1.append('uploadId', init.uploadId);
    fd1.append('index', '0');
    fd1.append('file', new Blob([bytes], { type: 'audio/webm' }), fileName);
    const chunkRes = await fetch(`${BASE}/upload/chunk`, { method: 'POST', body: fd1 });
    check('分片上传成功', chunkRes.ok);
    const fd2 = new FormData();
    fd2.append('uploadId', init.uploadId);
    fd2.append('totalChunks', '1');
    fd2.append('originalName', encodeURIComponent(fileName));
    fd2.append('size', String(bytes.length));
    fd2.append('nickname', nickname);
    fd2.append('clientId', clientId);
    fd2.append('room', 'main');
    fd2.append('audio', '1');
    // 广播可能在 complete 响应返回前到达 → 谓词不能依赖 comp，改用文件名匹配
    const liveP = waitMsg(s, (d) => d.type === 'file' && d.fileName === fileName);
    const comp = await (await fetch(`${BASE}/upload/complete`, { method: 'POST', body: fd2 })).json();
    check('complete 返回语音消息', comp.ok && comp.type === 'file' && comp.audio === true, JSON.stringify(comp));
    check('存储名带 .webm', /^[0-9]+-[a-f0-9]{12}\.webm$/.test(comp.storedName || ''), comp.storedName);
    const archFile = findUnder(path.join(TMP_UPLOAD, 'audio'), comp.storedName);
    check('归档到 audio/ 分类目录', !!archFile, archFile || '未找到');

    console.log('【实时广播 + 历史装饰 + 下载】');
    const live = await liveP;
    check('chat_message 广播带 audio', live.audio === true && live.type === 'file');
    const hist = await new Promise((res) => s.emit('history_page', { room: 'main', beforeId: 1e15, limit: 50 }, res));
    const hm = (hist.history || []).find((m) => m.id === comp.id);
    check('历史消息装饰 audio=true', !!hm && hm.audio === true && !!hm.downloadUrl, hm && JSON.stringify(hm).slice(0, 120));
    const dl = await fetch(`${BASE}/download/${comp.storedName}`);
    check('语音文件可下载 200', dl.ok);

    console.log('【不带 audio 标志：魔数识别】');
    const bytes2 = webmBytes(80);
    const fileName2 = '无标志语音.webm';
    const init2 = await (await fetch(`${BASE}/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: fileName2, size: bytes2.length, lastModified: 1 })
    })).json();
    const fd3 = new FormData();
    fd3.append('uploadId', init2.uploadId);
    fd3.append('index', '0');
    fd3.append('file', new Blob([bytes2], { type: 'audio/webm' }), fileName2);
    await fetch(`${BASE}/upload/chunk`, { method: 'POST', body: fd3 });
    const fd4 = new FormData();
    fd4.append('uploadId', init2.uploadId);
    fd4.append('totalChunks', '1');
    fd4.append('originalName', encodeURIComponent(fileName2));
    fd4.append('size', String(bytes2.length));
    fd4.append('nickname', nickname);
    fd4.append('clientId', clientId);
    fd4.append('room', 'main');
    const comp2 = await (await fetch(`${BASE}/upload/complete`, { method: 'POST', body: fd4 })).json();
    check('无标志仍按魔数识别为语音', comp2.ok && comp2.audio === true, JSON.stringify(comp2));

    console.log('【单文件上传（audio/* MIME）】');
    const fd5 = new FormData();
    fd5.append('file', new Blob([webmBytes(40)], { type: 'audio/webm' }), '单文件语音.webm');
    fd5.append('nickname', nickname);
    fd5.append('clientId', clientId);
    fd5.append('room', 'main');
    const single = await (await fetch(`${BASE}/upload`, { method: 'POST', body: fd5 })).json();
    check('单文件上传识别为语音消息', single.ok && single.audio === true, JSON.stringify(single));
    const singleFile = findUnder(path.join(TMP_UPLOAD, 'audio'), single.storedName);
    check('单文件也归档到 audio/', !!singleFile, singleFile || '未找到');

    s.disconnect();
  } finally {
    serverProc.kill();
    fs.rmSync(TMP_UPLOAD, { recursive: true, force: true });
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + s); } catch (_) { /* ignore */ } }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
