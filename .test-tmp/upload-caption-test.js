/* 图片配文 + 上传链路合规 集成测试：
 * - /upload 带 text 配文 → 广播的 chat_message(type=image) 含 text 与 mentions
 * - 被禁言用户上传 → 403（堵上"发图绕过禁言"漏洞），解禁后恢复
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3134;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-upload-caption.db');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emitAck = (s, e, d) => new Promise((res) => s.emit(e, d, res));

function startServer() {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE },
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
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId: cid } });
    s.once('welcome', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

async function uploadImage(clientId, text) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'a.png');
  fd.append('nickname', '上传者');
  fd.append('clientId', clientId);
  fd.append('room', 'main');
  if (text) fd.append('text', text);
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}

async function main() {
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  const proc = await startServer();
  let host, listener;
  try {
    host = await connectSocket('host-up');
    listener = await connectSocket('listener-up');
    // 给接收者一个固定昵称，便于配文里 @ 他（服务端 parseMentions 按在线用户解析）
    await new Promise((res) => listener.emit('set_nickname', { name: '张三' }, res));
    await sleep(50);

    // 监听下一条图片广播
    const nextImageMsg = () => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('未收到图片广播')), 5000);
      const h = (m) => { if (m && m.type === 'image') { clearTimeout(t); listener.off('chat_message', h); resolve(m); } };
      listener.on('chat_message', h);
    });

    console.log('【图片 + 配文一起发】');
    const p = nextImageMsg();
    const res = await uploadImage('cUp', '看这张图 @张三');
    check('上传返回 ok', res.status === 200 && res.body && res.body.ok, JSON.stringify(res.body));
    check('响应回带配文', res.body && res.body.text === '看这张图 @张三');
    const msg = await p;
    check('广播 type=image', msg.type === 'image');
    check('广播含配文 text', msg.text === '看这张图 @张三');
    check('配文解析出 @提及', Array.isArray(msg.mentions) && msg.mentions.includes('张三'), JSON.stringify(msg.mentions));

    console.log('【禁言后发图被 403】');
    const mute = await emitAck(host, 'admin_mute', { clientId: 'cUp', minutes: 10 });
    check('已禁言 cUp', mute && mute.ok);
    const blocked = await uploadImage('cUp', '被禁言还想发图');
    check('禁言期间上传被拒 403', blocked.status === 403 && /禁言/.test((blocked.body && blocked.body.error) || ''), JSON.stringify(blocked.body));

    console.log('【解禁后恢复】');
    await emitAck(host, 'admin_mute', { clientId: 'cUp', minutes: 0 });
    await sleep(50); // 限流窗口计数：解禁后立即发可能触发频控，用默认宽松窗口（12/10s）通常无碍
    const ok2 = await uploadImage('cUp2', '解禁后正常');
    check('解禁/另一用户上传恢复 200', ok2.status === 200 && ok2.body && ok2.body.ok, JSON.stringify(ok2.body));
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { host && host.disconnect(); } catch (_) {}
    try { listener && listener.disconnect(); } catch (_) {}
    proc.kill();
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
