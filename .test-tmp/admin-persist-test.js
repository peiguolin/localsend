/* 用户管理持久化测试：剔除/禁言写入 SQLite，重启服务器后仍生效。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3130;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-admin-persist.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error(`服务器启动超时`)), 8000);
  });
}

function connectSocket(clientId) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId } });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

// 期望被拒绝：连接后未收到 welcome 就被断开
function expectRejected(clientId, ms = 2500) {
  return new Promise((resolve) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId } });
    let welcomed = false;
    s.once('welcome', () => { welcomed = true; s.disconnect(); resolve(false); });
    s.once('disconnect', () => { if (!welcomed) resolve(true); });
    setTimeout(() => { try { s.disconnect(); } catch (_) {} resolve(!welcomed); }, ms);
  });
}

function emitAck(sock, event, data) {
  return new Promise((resolve) => { sock.emit(event, data, resolve); });
}

function waitSysMsg(sock, match, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待系统消息超时')), timeout);
    const h = (m) => {
      if (match && !match.test((m && m.text) || '')) return; // 跳过加入等无关系统消息
      clearTimeout(t); sock.off('system_message', h); resolve(m);
    };
    sock.on('system_message', h);
  });
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {} }

  console.log('【第 1 次启动：施加剔除 + 禁言】');
  let proc = await startServer(PORT);
  let host;
  try {
    host = await connectSocket('host-cid');
    const banRes = await emitAck(host.s, 'admin_kick', { clientId: 'cBan' });
    check('剔除(封禁) cBan', banRes && banRes.ok);
    const muteRes = await emitAck(host.s, 'admin_mute', { clientId: 'cMute', minutes: 60 });
    check('禁言 cMute 60 分钟', muteRes && muteRes.ok && muteRes.mutedUntil > Date.now());
    const botRes = await emitAck(host.s, 'admin_botban', { clientId: 'cBot', banned: true });
    check('禁机器人 cBot', botRes && botRes.ok);
  } finally {
    try { host && host.s.disconnect(); } catch (_) {}
    proc.kill();
    await sleep(400);
  }

  console.log('【重启：管理状态应持久】');
  proc = await startServer(PORT);
  try {
    const banRejected = await expectRejected('cBan');
    check('重启后 cBan 仍被拒绝（封禁持久）', banRejected);

    // cMute 未封禁，可连接；发言应被禁言拦截（禁言持久）
    const cMute = await connectSocket('cMute');
    const sysP = waitSysMsg(cMute.s, /禁言/);
    cMute.s.emit('chat_message', { text: '我还能说话吗', room: 'main', clientId: 'cMute' });
    const sys = await sysP;
    check('重启后 cMute 仍被禁言（禁言持久）', sys && /禁言/.test(sys.text || ''), sys && sys.text);
    cMute.s.disconnect();
  } catch (e) {
    check('重启验证无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    proc.kill();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {} }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
