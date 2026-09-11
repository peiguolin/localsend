/* 群聊房间集成测试：
 * - 创建群聊（自动命名）→ 创建者 + 被拉成员都出现在房间列表
 * - 消息隔离：群聊消息只发给成员；非成员收不到；公共房消息全员收
 * - 房间历史按 room 加载（room_history）
 * - 改名 / 普通成员退出 / 创建者解散
 * - 房间持久化：重启后房间列表与成员身份（clientId）恢复
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3107;
const BASE = `https://127.0.0.1:${PORT}`;
const TEST_DB = path.join(__dirname, 'group-test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// clientId 由测试外部指定，模拟持久身份
function connectSocket(clientId) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], auth: { clientId } });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname, history: w.history || [], rooms: w.rooms || [] }));
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
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  let serverProc = await startServer();

  try {
    console.log('【连接 3 个用户（A/B/C）】');
    const A = await connectSocket('cA');
    const B = await connectSocket('cB');
    const C = await connectSocket('cC');
    await sleep(300);
    check('A/B/C welcome 均无群聊房', A.rooms.length === 0 && B.rooms.length === 0 && C.rooms.length === 0);

    console.log('【A 创建群聊（拉 B，不拉 C）】');
    const invBP = waitEvent(B.s, 'group_invited');
    const createdP = waitEvent(A.s, 'group_created');
    const createRes = await emitAck(A.s, 'group_create', { targetIds: [B.id], name: '项目讨论组' });
    check('创建成功', createRes.ok === true && !!createRes.room.id);
    const roomId = createRes.room.id;
    check('房间号以 g 开头且唯一', /^g/.test(roomId));
    check('手动命名生效', createRes.room.name === '项目讨论组');
    check('成员为 A+B', createRes.room.members.length === 2);

    const inv = await invBP;
    check('B 收到 group_invited（自动加入）', inv.room && inv.room.id === roomId);
    const created = await createdP;
    check('A 收到 group_created', created.room && created.room.id === roomId);

    console.log('【默认自动命名】');
    const create2 = await emitAck(A.s, 'group_create', { targetIds: [C.id] });
    check('未传名字时自动命名', create2.ok && create2.room.name.length > 0 && create2.room.name.includes(C.nickname));

    console.log('【消息隔离：群聊消息只发给成员】');
    // A 在群聊发消息
    const bGotP = waitEvent(B.s, 'chat_message');
    A.s.emit('chat_message', { text: '群聊里的悄悄话', clientId: 'cA', room: roomId });
    const bGot = await bGotP;
    check('B 收到群聊消息', bGot.text === '群聊里的悄悄话' && bGot.room === roomId);
    // C 不应收到
    let cGot = false;
    const cListener = (m) => { if (m.text === '群聊里的悄悄话') cGot = true; };
    C.s.on('chat_message', cListener);
    await sleep(400);
    check('C（非成员）收不到群聊消息', cGot === false);
    C.s.off('chat_message', cListener);

    console.log('【公共房消息全员收到】');
    const aPubP = waitEvent(A.s, 'chat_message');
    const cPubP = waitEvent(C.s, 'chat_message');
    B.s.emit('chat_message', { text: '公共房广播', clientId: 'cB', room: 'main' });
    const aPub = await aPubP;
    const cPub = await cPubP;
    check('A 收到公共房消息', aPub.text === '公共房广播');
    check('C 收到公共房消息', cPub.text === '公共房广播');

    console.log('【房间历史按 room 加载】');
    const hist = await emitAck(A.s, 'room_history', { room: roomId });
    check('群聊历史含 1 条消息', hist.ok && hist.history.length === 1 && hist.history[0].text === '群聊里的悄悄话');
    const pubHist = await emitAck(A.s, 'room_history', { room: 'main' });
    check('公共房历史含广播消息', pubHist.ok && pubHist.history.some((m) => m.text === '公共房广播'));

    console.log('【非成员访问群聊历史被拒】');
    const denied = await emitAck(C.s, 'room_history', { room: roomId });
    check('C 加载群聊历史被拒', denied.ok === false);

    console.log('【群聊改名】');
    const renameRes = await emitAck(A.s, 'group_rename', { room: roomId, name: '改名后的组' });
    check('改名成功', renameRes.ok === true && renameRes.room.name === '改名后的组');

    console.log('【普通成员退出】');
    const leftP = waitEvent(B.s, 'group_left');
    const leaveRes = await emitAck(B.s, 'group_leave', { room: roomId });
    check('B 退出成功', leaveRes.ok === true);
    await leftP;
    const hist2 = await emitAck(A.s, 'room_history', { room: roomId });
    check('B 退出后历史仍在（房间未被解散）', hist2.ok && hist2.history.length === 1);
    // B 退出后无法再发消息到该群聊
    B.s.emit('chat_message', { text: '退出了还能发吗', clientId: 'cB', room: roomId });
    const aGotAfter = await Promise.race([
      waitEvent(A.s, 'chat_message').then(() => true).catch(() => false),
      sleep(500).then(() => false)
    ]);
    check('B 退出后消息不再广播', aGotAfter === false);

    console.log('【创建者解散】');
    // 解散前：搜索群聊消息（验证数据在库中）
    const searchBefore = await emitAck(A.s, 'history_search', { keyword: '悄悄话', room: roomId });
    check('解散前可在群聊内搜索到消息', searchBefore.ok && searchBefore.results.some((m) => m.text === '群聊里的悄悄话'));
    const disP = waitEvent(B.s, 'group_disbanded');
    const disbandRes = await emitAck(A.s, 'group_leave', { room: roomId });
    check('创建者退出 = 解散', disbandRes.ok === true && disbandRes.disbanded === true);
    await disP.catch(() => {});
    // 解散后房间从运行态删除 → room_history 被拒（非成员不可查）；消息仍在数据库
    const hist3 = await emitAck(A.s, 'room_history', { room: roomId });
    check('解散后房间不可再查（运行态已删除）', hist3.ok === false);

    console.log('【重启后房间持久化恢复】');
    const roomId2 = create2.room.id;
    A.s.disconnect(); B.s.disconnect(); C.s.disconnect();
    await sleep(400);
    serverProc.kill();
    await sleep(500);

    serverProc = await startServer();
    const A2 = await connectSocket('cA');
    const C2 = await connectSocket('cC');
    await sleep(300);
    check('重启后 A 的房间列表恢复（含自动命名房）', A2.rooms.some((r) => r.id === roomId2));
    check('重启后 C 的房间列表恢复（含自动命名房）', C2.rooms.some((r) => r.id === roomId2));
    check('重启后房间成员身份恢复（clientId）', A2.rooms.find((r) => r.id === roomId2).members.length === 2);
    const hist4 = await emitAck(A2.s, 'room_history', { room: roomId2 });
    check('重启后房间历史可查', hist4.ok && hist4.history.length === 0);
    // A 重启后还能在群聊发消息，C 能收到（房间仍在）
    const c2GotP = waitEvent(C2.s, 'chat_message');
    A2.s.emit('chat_message', { text: '重启后的群聊消息', clientId: 'cA', room: roomId2 });
    const c2Got = await c2GotP;
    check('重启后群聊消息仍可互发', c2Got.text === '重启后的群聊消息');

    A2.s.disconnect(); C2.s.disconnect();
    await sleep(300);
  } finally {
    serverProc.kill();
    await sleep(400);
  }

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
