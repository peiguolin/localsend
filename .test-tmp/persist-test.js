/* SQLite 持久化集成测试：
 * 用独立测试库（LOCALSEND_DB_FILE 指向 .test-tmp 下的临时库）验证：
 * 消息落盘、服务重启后历史恢复（welcome.history）、撤回联动数据库、
 * 白板笔迹落盘与重启后恢复、搜索、统计、清空。
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3103;
const BASE = `https://127.0.0.1:${PORT}`;
// 独立测试库：测试前后删除，不影响真实 data/chat.db
const TEST_DB = path.join(__dirname, 'persist-test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'] });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname, history: w.history || [] }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function emitAck(sock, event, data) {
  return new Promise((resolve) => {
    if (data === undefined) sock.emit(event, resolve);
    else sock.emit(event, data, resolve);
  });
}

function waitEvent(sock, event, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: TEST_DB },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

async function main() {
  // 清掉上次测试残留的库
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  let serverProc = await startServer();
  let senderNick = '';

  try {
    // 第一轮：发消息、画白板、撤回一条
    const a = await connectSocket();
    const b = await connectSocket();
    await sleep(300);
    senderNick = a.nickname;

    console.log('【消息落盘】');
    const recvP = waitEvent(b.s, 'chat_message');
    a.s.emit('chat_message', { text: '你好，持久化测试第一条', clientId: 'client-a' });
    const m1 = await recvP;
    check('消息广播成功', m1.text === '你好，持久化测试第一条' && !!m1.id);
    check('广播带 clientId', m1.clientId === 'client-a');

    const recvP2 = waitEvent(b.s, 'chat_message');
    a.s.emit('chat_message', { text: '第二条，稍后会被撤回', clientId: 'client-a' });
    const m2 = await recvP2;
    const recvP3 = waitEvent(b.s, 'chat_message');
    a.s.emit('chat_message', { text: '第三条，含关键词 SQLite', clientId: 'client-a' });
    await recvP3;
    await sleep(300);

    console.log('【统计】');
    const stats1 = await emitAck(a.s, 'history_stats');
    check('统计包含 3 条消息', stats1.ok && stats1.messages === 3);

    console.log('【搜索】');
    const search1 = await emitAck(a.s, 'history_search', { keyword: 'SQLite' });
    check('按关键词搜索命中', search1.ok && search1.results.length === 1 && search1.results[0].text.includes('SQLite'));
    const search2 = await emitAck(a.s, 'history_search', { nickname: a.nickname });
    check('按昵称搜索命中 3 条', search2.ok && search2.results.length === 3);

    console.log('【撤回联动数据库】');
    const recallRes = await emitAck(a.s, 'chat_recall', { id: m2.id, clientId: 'client-a' });
    check('撤回成功', recallRes.ok === true);
    await sleep(200);

    console.log('【白板落盘】');
    // wb_end：先 wb_begin 不需要（服务端只校验 wb_end 的 id 与样式）
    a.s.emit('wb_end', { id: 'stroke-1', author: a.nickname, color: '#4f6ef7', size: 4, tool: 'pen', pts: [[0.1, 0.2], [0.3, 0.4]] });
    await sleep(300);
    const wbJoin = await emitAck(b.s, 'wb_join');
    check('白板笔迹入库并可拉取', wbJoin.ok && wbJoin.strokes.some((s) => s.id === 'stroke-1'));

    a.s.disconnect(); b.s.disconnect();
    await sleep(400);
  } finally {
    serverProc.kill();
    await sleep(500);
  }

  // 第二轮：重启服务器（同一个测试库）→ 验证历史恢复
  serverProc = await startServer();
  try {
    console.log('【重启后历史恢复】');
    const c = await connectSocket();
    await sleep(300);
    const texts = c.history.map((m) => m.text).filter(Boolean);
    check('welcome.history 恢复 3 条消息', texts.length === 3);
    check('恢复的消息含第一条', texts.includes('你好，持久化测试第一条'));
    check('被撤回的消息带 recalled 标记', c.history.some((m) => m.recalled && m.text === '第二条，稍后会被撤回'));
    check('历史按时间正序', c.history.every((m, i) => i === 0 || c.history[i - 1].timestamp <= m.timestamp));
    check('恢复的消息保留 clientId', c.history.every((m) => m.clientId === 'client-a'));

    console.log('【重启后搜索/统计仍可用】');
    const stats2 = await emitAck(c.s, 'history_stats');
    check('重启后统计消息数 = 3（撤回的仍在计数）', stats2.ok && stats2.messages === 3);
    const search3 = await emitAck(c.s, 'history_search', { keyword: 'SQLite' });
    check('重启后搜索仍命中', search3.ok && search3.results.length === 1);

    console.log('【重启后白板恢复】');
    const wbJoin2 = await emitAck(c.s, 'wb_join');
    check('白板笔迹重启后仍可拉取', wbJoin2.ok && wbJoin2.strokes.some((s) => s.id === 'stroke-1'));

    console.log('【历史消息撤回（数据库直撤）】');
    // 历史消息不在内存 chatLog，撤回走 DB 路径；
    // 但撤回校验"仅本人"，先让 c 把昵称改成原发送者（a 已离线，昵称空闲）
    const renameRes = await emitAck(c.s, 'set_nickname', { name: senderNick, silent: true });
    check('改名成功（复用原发送者昵称）', renameRes && renameRes.ok === true);
    await sleep(200);
    // 历史消息不在内存 chatLog，撤回走 DB 路径
    const histMsg = c.history.find((m) => m.text === '你好，持久化测试第一条');
    const recallHist = await emitAck(c.s, 'chat_recall', { id: histMsg.id, clientId: 'client-a' });
    check('历史消息可撤回', recallHist.ok === true);
    const search4 = await emitAck(c.s, 'history_search', { keyword: '持久化测试第一条' });
    check('撤回后搜索不再返回原文', !search4.results.some((m) => !m.recalled));

    console.log('【清空历史】');
    const clearRes = await emitAck(c.s, 'history_clear', { includeStrokes: true });
    check('清空成功', clearRes.ok && clearRes.messages === 3);
    const stats3 = await emitAck(c.s, 'history_stats');
    check('清空后消息数 = 0', stats3.ok && stats3.messages === 0);
    const wbJoin3 = await emitAck(c.s, 'wb_join');
    check('清空后白板笔迹为空', wbJoin3.ok && wbJoin3.strokes.length === 0);

    c.s.disconnect();
    await sleep(300);
  } finally {
    serverProc.kill();
  }

  // 清理测试库
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
