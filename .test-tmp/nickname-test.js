/* 昵称修改功能集成测试：唯一性/校验/广播/共享昵称同步/静默改名/限速 */
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
    s.on('welcome', (w) => resolve({ s, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function emitAck(sock, event, data) {
  return new Promise((resolve) => sock.emit(event, data, resolve));
}

function waitEvent(sock, event, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  try {
    const { s: a, nickname: aNick } = await connectSocket();
    const { s: b } = await connectSocket();
    let aMembers = null;
    a.on('members_update', (m) => { aMembers = m; });

    console.log('【基本改名】');
    const sysP = waitEvent(a, 'system_message');
    const memP = waitEvent(a, 'members_update');
    const r1 = await emitAck(a, 'set_nickname', { name: '小明' });
    check('改名成功', r1.ok && r1.nickname === '小明');
    const sys = await sysP;
    check('广播改名系统消息', sys.type === 'rename' && sys.text.includes('改名为') && sys.text.includes('小明'), sys.text);
    await memP;
    check('成员列表已更新为新昵称', Array.isArray(aMembers) && aMembers.includes('小明'));

    console.log('【唯一性与校验】');
    const dup = await emitAck(b, 'set_nickname', { name: '小明' });
    check('重名被拒绝', !dup.ok && dup.error.includes('已被他人使用'), dup.error);
    const empty = await emitAck(b, 'set_nickname', { name: '   ' });
    check('空昵称被拒绝', !empty.ok);
    const long = await emitAck(b, 'set_nickname', { name: 'x'.repeat(21) });
    check('超长昵称被拒绝', !long.ok);
    const ctrl = await emitAck(b, 'set_nickname', { name: 'ab' + String.fromCharCode(7) });
    check('控制字符被拒绝', !ctrl.ok);
    const same = await emitAck(a, 'set_nickname', { name: '小明' });
    check('同名改名直接成功(no-op)', same.ok === true);

    console.log('【限速】');
    const q1 = await emitAck(b, 'set_nickname', { name: '小红' });
    check('首次改名成功', q1.ok === true);
    const q2 = await emitAck(b, 'set_nickname', { name: '小绿' });
    check('2 秒内再次改名被限速', !q2.ok && q2.error.includes('频繁'), q2.error);
    await sleep(2100);
    const q3 = await emitAck(b, 'set_nickname', { name: '小绿' });
    check('限速过后可改名', q3.ok === true);

    console.log('【共享昵称同步】');
    const reg = await emitAck(a, 'share_register', { name: '小明的共享' });
    check('注册共享成功', reg.ok === true);
    await sleep(2100);
    const sharesP = waitEvent(b, 'shares_update');
    const r2 = await emitAck(a, 'set_nickname', { name: '明明' });
    check('共享者改名成功', r2.ok === true);
    const shares = await sharesP;
    check('共享列表 owner 同步为新昵称', shares.some((s) => s.id === reg.shareId && s.owner === '明明'),
      JSON.stringify(shares));

    console.log('【静默改名】');
    const { s: c } = await connectSocket();
    let cSysCount = 0;
    a.on('system_message', () => { cSysCount++; });
    const rs = await emitAck(c, 'set_nickname', { name: '静默用户', silent: true });
    check('静默改名成功', rs.ok === true);
    await sleep(400);
    check('静默改名不广播系统消息', cSysCount === 0);
    check('静默改名仍更新成员列表', Array.isArray(aMembers) && aMembers.includes('静默用户'));

    a.disconnect(); b.disconnect(); c.disconnect();
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
