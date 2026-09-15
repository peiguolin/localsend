/* 用户管理集成测试：在线列表 / 禁言与解禁 / 禁机器人 / 剔除(封禁+断连+禁重连) / 解禁 / 非宿主机拒绝。
 * 主服务器默认 localAddrs（127.0.0.1 视为宿主机）；另起一个 localAddrs 受限的服务器验证非宿主机拒绝。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3120;
const BASE = `https://127.0.0.1:${PORT}`;
const PORT2 = 3121;
const BASE2 = `https://127.0.0.1:${PORT2}`;
const DB_FILE = path.join(__dirname, 'test-admin.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startLLM() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '机器人回复。' } }] }));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startServer(port, extraEnv) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error(`服务器(${port})启动超时`)), 8000);
  });
}

function connectSocket(clientId) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId } });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function emitAck(sock, event, data) {
  return new Promise((resolve) => { sock.emit(event, data, resolve); });
}

function waitEvent(sock, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (v) => { clearTimeout(t); resolve(v); });
  });
}

async function expectMsg(sock, pred, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待消息超时')), timeout);
    const h = (m) => { if (pred(m)) { clearTimeout(t); sock.off('chat_message', h); resolve(m); } };
    sock.on('chat_message', h);
  });
}

async function expectNoMsg(sock, pred, ms = 800) {
  let got = false;
  const h = (m) => { if (pred(m)) got = true; };
  sock.on('chat_message', h);
  await sleep(ms);
  sock.off('chat_message', h);
  return !got;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
  const llm = await startLLM();
  const llmPort = llm.address().port;

  console.log('【用户管理：禁言/禁机器人/剔除】');
  const proc = await startServer(PORT, {
    LOCALSEND_BOT_ENABLED: '1',
    LOCALSEND_BOT_BASE_URL: `http://127.0.0.1:${llmPort}`,
    LOCALSEND_BOT_NAME: '机器人'
  });
  let A, B;
  try {
    A = await connectSocket('cHost');
    B = await connectSocket('cB');

    const users = await emitAck(A.s, 'admin_users', {});
    check('admin_users 返回 ok', users && users.ok === true);
    check('在线列表含 B(clientId cB)', users.users.some((u) => u.clientId === 'cB'));
    check('在线列表含宿主机标记', users.users.some((u) => u.isLocal));

    // --- 禁言 ---
    const mute = await emitAck(A.s, 'admin_mute', { clientId: 'cB', minutes: 15 });
    check('禁言返回 ok', mute && mute.ok === true);
    B.s.emit('chat_message', { text: '被禁言时发的消息', room: 'main', clientId: 'cB' });
    const silent = await expectNoMsg(A.s, (m) => m && m.text === '被禁言时发的消息');
    check('被禁言用户发言不入库/不广播', silent);
    const unmute = await emitAck(A.s, 'admin_mute', { clientId: 'cB', minutes: 0 });
    check('解禁返回 ok', unmute && unmute.ok === true);
    const gotP = expectMsg(A.s, (m) => m && m.text === '解禁后能发言');
    B.s.emit('chat_message', { text: '解禁后能发言', room: 'main', clientId: 'cB' });
    await gotP;
    check('解禁后发言正常广播', true);

    // --- 禁机器人 ---
    await emitAck(A.s, 'admin_botban', { clientId: 'cB', banned: true });
    B.s.emit('chat_message', { text: '嗨 @机器人', room: 'main', clientId: 'cB' });
    const noBot = await expectNoMsg(A.s, (m) => m && m.isBot, 1000);
    check('被禁机器人用户 @机器人 不触发', noBot);
    await emitAck(A.s, 'admin_botban', { clientId: 'cB', banned: false });
    const botP = expectMsg(A.s, (m) => m && m.isBot);
    B.s.emit('chat_message', { text: '你好 @机器人', room: 'main', clientId: 'cB' });
    await botP;
    check('解禁机器人后 @机器人 正常触发', true);

    // --- 剔除（封禁+断连）---
    const discP = waitEvent(B.s, 'disconnect');
    const kick = await emitAck(A.s, 'admin_kick', { clientId: 'cB' });
    check('剔除返回 ok', kick && kick.ok === true);
    await discP;
    check('被剔除用户的连接被断开', true);
    // 重连被封禁拦截
    const rebanned = await (async () => {
      try {
        const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId: 'cB' } });
        const disc = waitEvent(s, 'disconnect', 4000);
        let gotWelcome = false;
        s.once('welcome', () => { gotWelcome = true; });
        await disc.catch(() => null);
        return !gotWelcome;
      } catch (_) { return false; }
    })();
    check('被剔除用户重连被拦截（无 welcome 即断开）', rebanned);
    // 解禁后可重连
    await emitAck(A.s, 'admin_unban', { clientId: 'cB' });
    const B2 = await connectSocket('cB');
    check('解除封禁后可重新连接', !!B2.id);
    B2.s.disconnect();
  } catch (e) {
    check('主流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { A && A.s.disconnect(); } catch (_) {}
    try { B && B.s.disconnect(); } catch (_) {}
    proc.kill();
  }

  // --- 非宿主机拒绝 ---
  console.log('【非宿主机拒绝】');
  const proc2 = await startServer(PORT2, { LOCALSEND_LOCAL_ADDRS: '10.255.255.1' }); // 不含 127.0.0.1
  try {
    const s = await new Promise((resolve, reject) => {
      const c = io(BASE2, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId: 'cX' } });
      c.once('welcome', () => resolve(c));
      c.on('connect_error', reject);
      setTimeout(() => reject(new Error('server2 connect timeout')), 5000);
    });
    const denied = await emitAck(s, 'admin_users', {});
    check('非宿主机 admin_users 被拒绝', denied && denied.ok === false);
    const denied2 = await emitAck(s, 'admin_mute', { clientId: 'cX', minutes: 15 });
    check('非宿主机 admin_mute 被拒绝', denied2 && denied2.ok === false);
    s.disconnect();
  } catch (e) {
    check('非宿主机拒绝流程无异常', false, String(e && e.message));
  } finally {
    proc2.kill();
    llm.close();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
