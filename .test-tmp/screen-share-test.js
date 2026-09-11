/* 屏幕共享信令集成测试：开始/独占/观看路由/角色校验/上限/退出/停止/断线清理 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3100;
const BASE = `https://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'] });
    // ss_state 与 welcome 几乎同时到达，提前缓存，避免监听器挂载前丢事件
    s.once('ss_state', (st) => { s.__ssState = st; });
    s.on('welcome', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function emitAck(sock, event, data) {
  return new Promise((resolve) => {
    // 不传 data 时 ack 必须占第一个参数位，否则服务端 (cb) 收到 undefined
    if (data === undefined) sock.emit(event, resolve);
    else sock.emit(event, data, resolve);
  });
}

function waitEvent(sock, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ss_state 与 welcome 分属不同 WS 帧，可能在 await 后才到；已缓存则直取，否则等下一帧
function getSsState(sock) {
  if (sock.__ssState) return Promise.resolve(sock.__ssState);
  return waitEvent(sock, 'ss_state');
}

async function main() {
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  const extraSockets = [];
  try {
    const a = await connectSocket();
    const b = await connectSocket();

    console.log('【开始与独占】');
    const startedP = waitEvent(b, 'ss_started');
    const r1 = await emitAck(a, 'ss_start');
    check('A 开始共享成功', r1.ok === true);
    const started = await startedP;
    check('广播 ss_started 含共享者信息', started.presenterId === a.id && typeof started.presenterName === 'string');
    const r2 = await emitAck(b, 'ss_start');
    check('第二人开始共享被拒', !r2.ok && r2.error.includes('正在共享'), r2.error);
    const c = await connectSocket();
    const cState = await getSsState(c);
    check('新连接获得 ss_state(active)', cState.active === true && cState.presenterId === a.id);

    console.log('【观看路由】');
    const joinedP = waitEvent(a, 'ss_viewer_joined');
    const w1 = await emitAck(b, 'ss_watch');
    check('B 观看成功', w1.ok === true && w1.presenterId === a.id);
    const joined = await joinedP;
    check('共享者收到 ss_viewer_joined', joined.viewerId === b.id && typeof joined.viewerName === 'string');
    let dupJoined = 0;
    a.on('ss_viewer_joined', () => { dupJoined++; });
    const w2 = await emitAck(b, 'ss_watch');
    check('重复观看幂等成功', w2.ok === true);
    await sleep(200);
    check('重复观看不重复通知共享者', dupJoined === 0, `收到 ${dupJoined} 次`);
    const selfWatch = await emitAck(a, 'ss_watch');
    check('共享者观看自己被拒', !selfWatch.ok);

    console.log('【SDP/ICE 角色校验】');
    const offerP = waitEvent(b, 'ss_offer');
    a.emit('ss_offer', { toId: b.id, sdp: { type: 'offer', sdp: 'fake' } });
    const offer = await offerP;
    check('ss_offer 共享者→观看者 正常转发', offer.fromId === a.id && offer.sdp.sdp === 'fake');
    let bGotOffer = false;
    a.once('ss_offer', () => { bGotOffer = true; });
    b.emit('ss_offer', { toId: a.id, sdp: { type: 'offer', sdp: 'evil' } });
    await sleep(250);
    check('ss_offer 观看者→共享者 被拦截', bGotOffer === false);

    const ansP = waitEvent(a, 'ss_answer');
    b.emit('ss_answer', { toId: a.id, sdp: { type: 'answer', sdp: 'fake' } });
    const ans = await ansP;
    check('ss_answer 观看者→共享者 正常转发', ans.fromId === b.id);
    let bGotAns = false;
    b.once('ss_answer', () => { bGotAns = true; });
    a.emit('ss_answer', { toId: b.id, sdp: { type: 'answer', sdp: 'evil' } });
    await sleep(250);
    check('ss_answer 共享者→观看者 被拦截', bGotAns === false);

    const ice1P = waitEvent(b, 'ss_ice');
    a.emit('ss_ice', { toId: b.id, candidate: { candidate: 'c1' } });
    await ice1P;
    check('ss_ice 共享者→观看者 转发', true);
    const ice2P = waitEvent(a, 'ss_ice');
    b.emit('ss_ice', { toId: a.id, candidate: { candidate: 'c2' } });
    await ice2P;
    check('ss_ice 观看者→共享者 转发', true);
    let cGotIce = false;
    c.once('ss_ice', () => { cGotIce = true; });
    a.emit('ss_ice', { toId: c.id, candidate: { candidate: 'evil' } }); // C 不是观看者
    await sleep(250);
    check('ss_ice 发往非观看者被拦截', cGotIce === false);

    console.log('【观看上限】');
    // B 已是观看者 1；再进 7 个应成功，第 9 个被拒
    const ds = [];
    for (let i = 0; i < 7; i++) {
      const d = await connectSocket();
      extraSockets.push(d);
      ds.push(d);
      const w = await emitAck(d, 'ss_watch');
      if (!w.ok) check(`第 ${i + 2} 位观看者应成功`, false, w.error);
    }
    check('前 8 位观看者全部成功', true);
    const d9 = await connectSocket();
    extraSockets.push(d9);
    const w9 = await emitAck(d9, 'ss_watch');
    check('第 9 位观看者被拒(人数已满)', !w9.ok && w9.error.includes('已满'), w9.error);

    console.log('【退出与停止】');
    const leftP = waitEvent(a, 'ss_viewer_left');
    ds[0].emit('ss_unwatch');
    const left = await leftP;
    check('退出观看通知共享者', left.viewerId === ds[0].id);
    // 非共享者停止 → 无效
    let gotEnded = false;
    b.once('ss_ended', () => { gotEnded = true; });
    b.emit('ss_stop');
    await sleep(250);
    check('非共享者 ss_stop 无效', gotEnded === false);
    // 共享者停止 → 全员收到
    const endedP = waitEvent(b, 'ss_ended');
    a.emit('ss_stop');
    const ended = await endedP;
    check('共享者停止广播 ss_ended', ended.reason === 'stop');
    const e = await connectSocket();
    extraSockets.push(e);
    const eState = await getSsState(e);
    check('停止后 ss_state 为 inactive', eState.active === false);

    console.log('【断线清理】');
    await emitAck(a, 'ss_start');
    const w3 = await emitAck(b, 'ss_watch');
    check('B 重新观看成功', w3.ok === true);
    // 观看者断线 → 共享者收到 left
    const bId = b.id;
    const left2P = waitEvent(a, 'ss_viewer_left');
    b.disconnect();
    const left2 = await left2P;
    check('观看者断线通知共享者', left2.viewerId === bId);
    // 共享者断线 → 全员 ended(offline)
    const c2 = await connectSocket();
    extraSockets.push(c2);
    const ended2P = waitEvent(c2, 'ss_ended');
    a.disconnect();
    const ended2 = await ended2P;
    check('共享者断线广播 ss_ended(offline)', ended2.reason === 'offline');
    const f = await connectSocket();
    extraSockets.push(f);
    const fState = await getSsState(f);
    check('断线后 ss_state 为 inactive', fState.active === false);

    for (const s of extraSockets) s.disconnect();
    c.disconnect(); c2.disconnect();
  } finally {
    serverProc.kill();
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
