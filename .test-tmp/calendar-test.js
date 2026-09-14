/* 日历集成测试：节假日接口 / 共享日程 CRUD / 房间隔离 / 删除权限 / 变更广播 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { io } = require('socket.io-client');

const PORT = 3100;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-cal.db');

let failures = 0;
let skipped = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function skip(name) { skipped++; console.log(`  ⊘ ${name}（无可用局域网 IP，跳过）`); }

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

function connectSocket(host, clientId) {
  return new Promise((resolve, reject) => {
    const s = io(`https://${host}:${PORT}`, {
      rejectUnauthorized: false, transports: ['websocket'], auth: { clientId }
    });
    s.on('welcome', (w) => resolve({ s, welcome: w }));
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

function waitEvent(sock, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

async function getYear(year) {
  return (await fetch(`${BASE}/api/calendar/year?year=${year}`)).json();
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_LOCAL_ADDRS: '127.0.0.1,::1,::ffff:127.0.0.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  try {
    console.log('【节假日接口】');
    const y25 = await getYear(2025);
    check('2025 春节区间展开正确', y25.ok && y25.official &&
      y25.days['2025-01-28'] && y25.days['2025-01-28'].name === '春节' &&
      y25.days['2025-01-28'].index === 1 && y25.days['2025-01-28'].total === 8);
    check('2025 春节第 8 天', y25.days['2025-02-04'] && y25.days['2025-02-04'].index === 8);
    check('2025 调休上班日标记', y25.days['2025-01-26'] && y25.days['2025-01-26'].type === 'workday');
    check('2025 国庆中秋合并假第 6 天是中秋', y25.days['2025-10-06'] && y25.days['2025-10-06'].index === 6);
    const y26 = await getYear(2026);
    check('2026 春节标记', y26.official && y26.days['2026-02-17'] && y26.days['2026-02-17'].name === '春节');
    check('2026 中秋标记', y26.days['2026-09-25'] && y26.days['2026-09-25'].name === '中秋节');
    const y27 = await getYear(2027);
    check('未收录年份降级 official:false', y27.ok && y27.official === false && Object.keys(y27.days).length === 0);
    const yBad = await fetch(`${BASE}/api/calendar/year?year=abc`);
    check('非法年份 400', yBad.status === 400);

    console.log('【日程 CRUD 与校验】');
    const { s: a, welcome: aw } = await connectSocket('127.0.0.1', 'cal-A');
    const { s: b, welcome: bw } = await connectSocket('127.0.0.1', 'cal-B');

    const add1 = await emitAck(a, 'cal_event_add', {
      room: 'main', date: '2026-09-15', time: '14:00', title: '版本评审', note: '带测试报告'
    });
    check('添加日程成功', add1.ok && add1.event && add1.event.title === '版本评审' &&
      add1.event.time === '14:00' && add1.event.creatorClientId === 'cal-A');
    const bad1 = await emitAck(a, 'cal_event_add', { room: 'main', date: '2026-13-40', title: 'x' });
    check('非法日期被拒', !bad1.ok);
    const bad2 = await emitAck(a, 'cal_event_add', { room: 'main', date: '2026-09-15', time: '25:99', title: 'x' });
    check('非法时间被拒', !bad2.ok);
    const bad3 = await emitAck(a, 'cal_event_add', { room: 'main', date: '2026-09-15', title: '  ' });
    check('空标题被拒', !bad3.ok);
    const bad4 = await emitAck(a, 'cal_event_add', { room: 'main', date: '2026-09-15', title: 'x'.repeat(61) });
    check('超长标题被拒', !bad4.ok);

    const month = await emitAck(a, 'cal_events_month', { room: 'main', month: '2026-09' });
    check('按月拉取含新日程', month.ok && month.events.some((e) => e.title === '版本评审'));

    console.log('【房间隔离】');
    const created = await emitAck(a, 'group_create', { name: '日历测试房', targetIds: [bw.id] });
    const roomId = created.room.id;
    const { s: c } = await connectSocket('127.0.0.1', 'cal-C');
    const deniedList = await emitAck(c, 'cal_events_month', { room: roomId, month: '2026-09' });
    check('非成员拉取房间日程被拒', !deniedList.ok);
    const deniedAdd = await emitAck(c, 'cal_event_add', { room: roomId, date: '2026-09-15', title: '闯入' });
    check('非成员添加房间日程被拒', !deniedAdd.ok);
    const changedP = waitEvent(b, 'cal_event_changed');
    const addRoom = await emitAck(b, 'cal_event_add', { room: roomId, date: '2026-09-20', time: '10:30', title: '排班讨论' });
    check('成员添加房间日程成功', addRoom.ok === true);
    const changed = await changedP;
    check('变更广播送达房间成员', changed.room === roomId && changed.action === 'add');
    const mainMonth = await emitAck(a, 'cal_events_month', { room: 'main', month: '2026-09' });
    check('房间日程不泄漏到公共房', !mainMonth.events.some((e) => e.title === '排班讨论'));

    console.log('【删除权限】');
    const evId = addRoom.event.id; // B 在房间里的日程
    const lanIP = getLanIP();
    if (lanIP) {
      // 远端通道（局域网 IP → 非宿主机）：非创建者拒绝、创建者放行
      const { s: ra } = await connectSocket(lanIP, 'cal-RA');
      const { s: rb } = await connectSocket(lanIP, 'cal-RB');
      const addMain = await emitAck(ra, 'cal_event_add', { room: 'main', date: '2026-09-22', title: '远端事件' });
      check('远端创建日程成功', addMain.ok === true);
      const deniedDel = await emitAck(rb, 'cal_event_delete', { id: addMain.event.id });
      check('远端非创建者删除被拒', !deniedDel.ok && deniedDel.error.includes('只能删除自己'), deniedDel.error);
      const okDel = await emitAck(ra, 'cal_event_delete', { id: addMain.event.id });
      check('远端创建者删除成功', okDel.ok === true);
      ra.disconnect(); rb.disconnect();
    } else {
      skip('远端删除权限');
    }
    // 宿主机（回环）可删任何日程
    const adminDel = await emitAck(a, 'cal_event_delete', { id: evId });
    check('宿主机可删除他人日程', adminDel.ok === true, adminDel.error);
    const delGone = await emitAck(b, 'cal_event_delete', { id: 999999 });
    check('删除不存在日程报错', !delGone.ok);

    console.log('【前端资产】');
    const pub = path.join(__dirname, '..', 'public');
    check('lunar.js 已 vendor', fs.existsSync(path.join(pub, 'vendor', 'lunar.js')) &&
      fs.statSync(path.join(pub, 'vendor', 'lunar.js')).size > 300000);
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    check('页面含日历 Tab 与脚本', html.includes('id="tabCalendar"') && html.includes('calendar.js'));
    check('页面加载 lunar.js', html.includes('vendor/lunar.js'));

    a.disconnect(); b.disconnect(); c.disconnect();
  } finally {
    serverProc.kill();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
  }

  console.log(failures === 0 ? `\n全部通过 ✅${skipped ? `（跳过 ${skipped} 项）` : ''}` : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
