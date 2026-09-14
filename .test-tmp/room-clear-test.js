/* 数据管理权限集成测试（双通道：127.0.0.1=宿主机 / 局域网IP=非宿主机）：
 * 公共房清空锁、数据导出锁、房主清空本房间、宿主机管理员兜底、内存索引按房间隔离 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3100;
const DB_FILE = path.join(__dirname, 'test-perm.db');

let failures = 0;
let skipped = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function skip(name) {
  skipped++;
  console.log(`  ⊘ ${name}（无可用局域网 IP，跳过）`);
}

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = typeof net.family === 'string' ? net.family : `IPv${net.family}`;
      if (family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function connectSocket(host, clientId, port = PORT) {
  return new Promise((resolve, reject) => {
    const s = io(`https://${host}:${port}`, {
      rejectUnauthorized: false,
      transports: ['websocket'],
      auth: { clientId }
    });
    s.on('welcome', (w) => resolve({ s, welcome: w }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function startServer(port, extraEnv = {}) {
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

function emitAck(sock, event, data) {
  return new Promise((resolve) => {
    if (data === undefined) sock.emit(event, resolve);
    else sock.emit(event, data, resolve);
  });
}

function waitMsg(sock, pred, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待消息超时')), timeout);
    const h = (d) => {
      if (pred(d)) {
        clearTimeout(t);
        sock.off('chat_message', h);
        resolve(d);
      }
    };
    sock.on('chat_message', h);
  });
}

function waitEvent(sock, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

async function main() {
  // 隔离测试数据库
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ }
  }
  // 显式把"宿主机"限定为回环：这样经局域网 IP 的连接即为非宿主机，可测拒绝路径
  const serverProc = await startServer(PORT, { LOCALSEND_LOCAL_ADDRS: '127.0.0.1,::1,::ffff:127.0.0.1' });

  const lanIP = getLanIP();
  console.log(`（宿主机回环=127.0.0.1，非宿主机通道=${lanIP || '不可用'}）\n`);

  try {
    const { s: localSock, welcome: localW } = await connectSocket('127.0.0.1', 'client-local');

    console.log('【宿主机判定】');
    check('回环连接 welcome.isLocal = true', localW.isLocal === true);
    let remote = null;
    if (lanIP) {
      remote = await connectSocket(lanIP, 'client-remote');
      check('局域网 IP 连接 welcome.isLocal = false', remote.welcome.isLocal === false);
    } else {
      skip('局域网 IP 连接判定');
    }

    console.log('【公共房清空与导出锁】');
    if (remote) {
      const denied = await emitAck(remote.s, 'history_clear', { includeStrokes: false });
      check('非宿主机清空公共房被拒', !denied.ok && denied.error.includes('仅宿主机'), denied.error);
      const expDenied = await fetch(`https://${lanIP}:${PORT}/data-export`);
      check('非宿主机导出数据被拒(403)', expDenied.status === 403);
    } else {
      skip('非宿主机清空/导出');
    }
    const okClear = await emitAck(localSock, 'history_clear', { includeStrokes: false });
    check('宿主机清空公共房成功', okClear.ok === true, okClear.error);
    const expOk = await fetch(`https://127.0.0.1:${PORT}/data-export`);
    check('宿主机导出数据成功(200)', expOk.status === 200);

    console.log('【房间清空权限】');
    // A（房主，远端通道）+ B（成员，远端通道）
    const hostA = lanIP || '127.0.0.1';
    const { s: a } = await connectSocket(hostA, 'client-A');
    const { s: b, welcome: bW } = await connectSocket(hostA, 'client-B');
    const created = await emitAck(a, 'group_create', { name: '权限测试房', targetIds: [bW.id] });
    check('创建群聊房成功', created.ok && created.room && created.room.id);
    const roomId = created.room.id;

    // A 在房间里发消息
    let p = waitMsg(a, (d) => d.room === roomId && d.text === '房间消息1');
    a.emit('chat_message', { text: '房间消息1', room: roomId, clientId: 'client-A' });
    const g1 = await p;
    check('房间消息广播带 ID', typeof g1.id === 'string');

    // B（远端非房主）清空 → 拒
    const deniedB = await emitAck(b, 'room_history_clear', { room: roomId });
    check(lanIP ? '非房主非宿主机清空房间被拒' : '非房主清空房间被拒(同机回环下仅校验房主)',
      !deniedB.ok && deniedB.error.includes('仅房主'), deniedB.error);

    // C（宿主机非成员）清空 → 允许（管理员兜底）
    const clearedP = waitEvent(b, 'room_cleared');
    const okC = await emitAck(localSock, 'room_history_clear', { room: roomId });
    check('宿主机管理员可清空任意房间', okC.ok === true, okC.error);
    const cleared = await clearedP;
    check('房间成员收到 room_cleared 广播', cleared.room === roomId);
    const hist1 = await emitAck(a, 'room_history', { room: roomId });
    check('清空后房间历史为空', hist1.ok && hist1.history.length === 0);

    // 房主自己清空
    p = waitMsg(a, (d) => d.room === roomId && d.text === '房间消息2');
    a.emit('chat_message', { text: '房间消息2', room: roomId, clientId: 'client-A' });
    await p;
    const okA = await emitAck(a, 'room_history_clear', { room: roomId });
    check('房主清空自己房间成功', okA.ok === true, okA.error);
    const hist2 = await emitAck(a, 'room_history', { room: roomId });
    check('房主清空后历史为空', hist2.ok && hist2.history.length === 0);

    console.log('【引用索引按房间隔离】');
    // 房间里再发一条（入内存索引），公共房再发一条；清公共房后：房间消息仍可引用，公共消息不可引用
    p = waitMsg(a, (d) => d.room === roomId && d.text === '房间消息3');
    a.emit('chat_message', { text: '房间消息3', room: roomId, clientId: 'client-A' });
    const g3 = await p;
    p = waitMsg(localSock, (d) => (d.room === 'main' || !d.room) && d.text === '公共消息');
    localSock.emit('chat_message', { text: '公共消息', clientId: 'client-local' });
    const m1 = await p;
    await emitAck(localSock, 'history_clear', { includeStrokes: false });

    p = waitMsg(b, (d) => d.room === roomId && d.text === '引用房间消息');
    b.emit('chat_message', { text: '引用房间消息', room: roomId, clientId: 'client-B', quoteId: g3.id });
    let m = await p;
    check('清空公共房后房间消息仍可引用', m.quote && m.quote.text === '房间消息3', JSON.stringify(m.quote));

    p = waitMsg(b, (d) => d.room === roomId && d.text === '引用公共消息');
    b.emit('chat_message', { text: '引用公共消息', room: roomId, clientId: 'client-B', quoteId: m1.id });
    m = await p;
    check('公共房消息索引已被隔离清空', !m.quote);

    console.log('【默认定义：本机用局域网 IP 访问也算宿主机】');
    if (lanIP) {
      // 不加 LOCALSEND_LOCAL_ADDRS，走默认的"回环 ∪ 本机网卡 IP"定义
      const proc2 = await startServer(3101);
      try {
        const { s: sameMachine, welcome: smW } = await connectSocket(lanIP, 'client-home', 3101);
        check('本机经局域网 IP 连接默认判定为宿主机', smW.isLocal === true);
        const ok = await emitAck(sameMachine, 'history_clear', { includeStrokes: false });
        check('该连接可执行清空', ok.ok === true, ok.error);
        sameMachine.disconnect();
      } finally {
        proc2.kill();
      }
    } else {
      skip('默认定义局域网 IP 判定');
    }

    localSock.disconnect(); a.disconnect(); b.disconnect();
    if (remote) remote.s.disconnect();
  } finally {
    serverProc.kill();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ }
    }
  }

  console.log(failures === 0
    ? `\n全部通过 ✅${skipped ? `（跳过 ${skipped} 项）` : ''}`
    : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
