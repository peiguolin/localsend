/* 历史分页集成测试：history_page 返回 beforeId 之前的更早消息（升序）+ 权限校验。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3150;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-history.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE, LOCALSEND_MSG_RATE_LIMIT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

function connectSocket(clientId) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId } });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname, history: w.history || [] }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}
const emitAck = (sock, evt, data) => new Promise((resolve) => sock.emit(evt, data, resolve));

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {} }

  console.log('【历史分页：beforeId 之前的更早消息】');
  const proc = await startServer(PORT);
  let A;
  try {
    A = await connectSocket('cA');
    // 发 30 条消息
    for (let i = 1; i <= 30; i++) A.s.emit('chat_message', { text: `消息 ${i}`, room: 'main', clientId: 'cA' });
    await sleep(500);

    // 用第二个连接拿 welcome 历史（升序，含 numericId）
    const B = await connectSocket('cB');
    check('welcome 历史含全部 30 条', B.history.length === 30, `实得 ${B.history.length}`);
    check('历史消息带 numericId', B.history.every((m) => m && typeof m.numericId === 'number'));
    check('历史升序（numericId 递增）', B.history.every((m, i) => i === 0 || B.history[i - 1].numericId < m.numericId));

    // 以第 10 条为界，取更早的 9 条
    const beforeId = B.history[9].numericId; // 第 10 条
    const page = await emitAck(B.s, 'history_page', { room: 'main', beforeId, limit: 50 });
    check('history_page 返回 ok', page && page.ok);
    check('返回 9 条更早消息', page.history.length === 9, `实得 ${page.history.length}`);
    check('返回消息都早于边界', page.history.every((m) => m.numericId < beforeId));
    check('返回升序', page.history.every((m, i) => i === 0 || page.history[i - 1].numericId < m.numericId));
    check('最早一条是「消息 1」', page.history[0] && /消息 1/.test(page.history[0].text || ''));
    check('最晚一条是「消息 9」', page.history[8] && /消息 9/.test(page.history[8].text || ''));

    // 再往更早取 → 无更早
    const page2 = await emitAck(B.s, 'history_page', { room: 'main', beforeId: page.history[0].numericId, limit: 50 });
    check('更早分页返回空（无更早消息）', page2.ok && page2.history.length === 0);

    // 权限：群聊房非成员被拒
    const denied = await emitAck(B.s, 'history_page', { room: 'g-none', beforeId: 1, limit: 50 });
    check('非成员访问群聊房历史被拒', !denied.ok);
    B.s.disconnect();
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { A && A.s.disconnect(); } catch (_) {}
    proc.kill();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {} }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
