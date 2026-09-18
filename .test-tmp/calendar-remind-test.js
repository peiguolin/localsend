/* 日历三期集成测试：到点提醒（触发/去重/防爆/房间隔离）+ 一键拉会成员计算 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { io } = require('socket.io-client');

const PORT = 3100;
const DB_FILE = path.join(__dirname, 'test-remind.db');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
function hmAfter(min) {
  const t = new Date(Date.now() + min * 60000);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_LOCAL_ADDRS: '127.0.0.1,::1,::ffff:127.0.0.1',
      LOCALSEND_REMIND_TICK_MS: '400'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  try {
    const { s: a } = await connectSocket('127.0.0.1', 'rem-A');
    const { s: b, welcome: bw } = await connectSocket('127.0.0.1', 'rem-B');
    const { s: c } = await connectSocket('127.0.0.1', 'rem-C');

    // 收集日历系统消息
    const calMsgs = { a: [], b: [], c: [] };
    for (const [k, s] of Object.entries({ a, b, c })) {
      s.on('system_message', (d) => { if (d && d.type === 'calendar') calMsgs[k].push(d); });
    }

    console.log('【到点提醒触发】');
    const today = todayStr();
    const time = hmAfter(2); // 2 分钟后开始，提前 10 分钟提醒 → 立即到触发点
    const add1 = await emitAck(a, 'cal_event_add', {
      room: 'main', date: today, time, title: '晨会', remind: 10
    });
    check('带提醒日程创建成功', add1.ok && add1.event.remindMinutes === 10);
    await sleep(2500);
    check('提醒已推送到公共房', calMsgs.a.some((m) => m.text.includes('晨会') && m.text.includes('日程提醒')),
      JSON.stringify(calMsgs.a));
    check('提醒文案含开始时间', calMsgs.a.some((m) => m.text.includes(time)));
    await sleep(1500);
    const fireCount = calMsgs.a.filter((m) => m.text.includes('晨会')).length;
    check('提醒只触发一次', fireCount === 1, `触发 ${fireCount} 次`);

    console.log('【重启防爆/过期静默】');
    const yest = new Date(Date.now() - 86400000);
    const yestStr = `${yest.getFullYear()}-${pad(yest.getMonth() + 1)}-${pad(yest.getDate())}`;
    await emitAck(a, 'cal_event_add', { room: 'main', date: yestStr, time: '08:00', title: '昨日旧事', remind: 10 });
    await sleep(1500);
    check('过期提醒不刷屏', !calMsgs.a.some((m) => m.text.includes('昨日旧事')));
    const monthCheck = await emitAck(a, 'cal_events_month', { room: 'main', month: yestStr.slice(0, 7) });
    const yestEv = monthCheck.events.find((e) => e.title === '昨日旧事');
    check('过期提醒已被静默标记(remindedAt>0)', yestEv && yestEv.remindedAt > 0);

    console.log('【提醒校验】');
    const noTime = await emitAck(a, 'cal_event_add', { room: 'main', date: today, title: '全天事', remind: 30 });
    check('无时间日程提醒强制为 0', noTime.ok && noTime.event.remindMinutes === 0);
    const badRemind = await emitAck(a, 'cal_event_add', { room: 'main', date: today, time, title: 'x', remind: 9999 });
    check('非法提醒档位被拒', !badRemind.ok);

    console.log('【房间隔离提醒】');
    const created = await emitAck(a, 'group_create', { name: '提醒测试房', targetIds: [bw.id] });
    const roomId = created.room.id;
    const roomTime = hmAfter(2);
    await emitAck(a, 'cal_event_add', { room: roomId, date: today, time: roomTime, title: '房间例会', remind: 10 });
    await sleep(2500);
    check('房间成员收到提醒', calMsgs.b.some((m) => m.text.includes('房间例会')));
    check('非成员收不到房间提醒', !calMsgs.c.some((m) => m.text.includes('房间例会')));

    console.log('【一键拉会成员计算】');
    const mainEv = await emitAck(a, 'cal_event_add', { room: 'main', date: today, title: '公共会议' });
    const t1 = await emitAck(a, 'cal_meeting_targets', { id: mainEv.event.id });
    check('公共房拉会：排除自己', t1.ok && !t1.targets.includes(a.id));
    check('公共房拉会：含其他在线成员', t1.targets.includes(b.id) && t1.targets.includes(c.id));
    const roomEv = await emitAck(b, 'cal_event_add', { room: roomId, date: today, title: '房间会议' });
    const t2 = await emitAck(b, 'cal_meeting_targets', { id: roomEv.event.id });
    check('房间拉会：只含房间成员', t2.ok && t2.targets.includes(a.id) && !t2.targets.includes(c.id),
      JSON.stringify(t2.targets));
    const t3 = await emitAck(c, 'cal_meeting_targets', { id: roomEv.event.id });
    check('非成员拉会被拒', !t3.ok);
    const t4 = await emitAck(a, 'cal_meeting_targets', { id: 999999 });
    check('不存在日程拉会报错', !t4.ok);

    console.log('【前端资产】');
    const pub = path.join(__dirname, '..', 'public');
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    check('今日横幅元素存在', html.includes('id="todayBanner"'));
    check('提醒档位选择器存在', html.includes('id="calEvRemind"'));
    // callTargets 在 call-session 子片导出（call.js 为门面，负责装配）
    const callSession = fs.readFileSync(path.join(pub, 'client-parts', 'call-session.js'), 'utf8');
    const callFacade = fs.readFileSync(path.join(pub, 'client-parts', 'call.js'), 'utf8');
    const shell = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
    check('call 会话片暴露 callTargets', callSession.includes('callTargets'));
    check('call 门面装配子片', callFacade.includes("require('./call-session.js')"));
    check('client.js 装配 call 分片', shell.includes("require('./client-parts/call.js')"));

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
