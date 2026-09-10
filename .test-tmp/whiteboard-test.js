/* 实时白板集成测试：笔迹中继/校验钳制/历史拉取/撤销/清空 */
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
    s.on('welcome', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function waitEvent(sock, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

function wbJoin(sock) {
  return new Promise((resolve) => sock.emit('wb_join', resolve));
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
    const a = await connectSocket();
    const b = await connectSocket();

    console.log('【笔迹中继】');
    const beginP = waitEvent(b, 'wb_begin');
    a.emit('wb_begin', { id: 's1', color: '#ff0000', size: 5, tool: 'pen', x: 0.1, y: 0.2 });
    const begin = await beginP;
    check('wb_begin 中继含样式与首点', begin.id === 's1' && begin.color === '#ff0000' &&
      begin.size === 5 && begin.x === 0.1 && begin.y === 0.2 && typeof begin.author === 'string');

    const ptsP = waitEvent(b, 'wb_pts');
    a.emit('wb_pts', { id: 's1', pts: [[0.3, 0.4], [2, -1], ['x', 0.5], [0.5, 0.5]] });
    const pts = await ptsP;
    check('wb_pts 中继并钳制/过滤非法点', pts.id === 's1' && pts.pts.length === 3 &&
      pts.pts[1][0] === 1 && pts.pts[1][1] === 0, JSON.stringify(pts.pts));

    const endP = waitEvent(b, 'wb_end');
    a.emit('wb_end', { id: 's1', color: '#ff0000', size: 5, tool: 'pen', pts: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.5]] });
    const end = await endP;
    check('wb_end 中继完成通知', end.id === 's1');

    console.log('【历史拉取】');
    const c = await connectSocket();
    const state = await wbJoin(c);
    check('wb_join 返回完整笔迹', state.ok && state.strokes.length === 1 &&
      state.strokes[0].id === 's1' && state.strokes[0].pts.length === 3);

    console.log('【校验净化】');
    a.emit('wb_end', { id: 'bad', color: 'javascript:alert(1)', size: 999, tool: 'xss', pts: [[0.1, 0.1]] });
    await new Promise((r) => setTimeout(r, 200));
    const state2 = await wbJoin(c);
    const bad = state2.strokes.find((s) => s.id === 'bad');
    check('非法颜色/粗细/工具被净化', bad && bad.color === '#1f2328' && bad.size === 40 && bad.tool === 'pen',
      bad && `${bad.color}/${bad.size}/${bad.tool}`);
    a.emit('wb_end', { id: 'empty', color: '#000000', size: 3, tool: 'pen', pts: [] });
    await new Promise((r) => setTimeout(r, 200));
    const state3 = await wbJoin(c);
    check('空笔迹不入历史', !state3.strokes.some((s) => s.id === 'empty'));

    console.log('【撤销】');
    // B 画一笔（A 的撤销不应影响它）
    b.emit('wb_end', { id: 'b1', color: '#00ff00', size: 3, tool: 'pen', pts: [[0.2, 0.2], [0.4, 0.4]] });
    await new Promise((r) => setTimeout(r, 200));
    let rmP = waitEvent(b, 'wb_remove');
    a.emit('wb_undo'); // 应撤销 A 的最后一笔 'bad'
    let rm = await rmP;
    check('撤销移除自己的最后一笔(bad)', rm.id === 'bad', rm.id);
    rmP = waitEvent(b, 'wb_remove');
    a.emit('wb_undo'); // 应撤销 A 的 's1'
    rm = await rmP;
    check('再次撤销移除 s1', rm.id === 's1', rm.id);
    const state4 = await wbJoin(c);
    check('撤销后 B 的笔迹保留', state4.strokes.length === 1 && state4.strokes[0].id === 'b1');
    // A 已没有笔迹，再撤销应静默无广播
    let gotExtra = false;
    b.once('wb_remove', () => { gotExtra = true; });
    a.emit('wb_undo');
    await new Promise((r) => setTimeout(r, 300));
    check('无可撤销笔迹时不广播', gotExtra === false);

    console.log('【清空】');
    const clrP = waitEvent(a, 'wb_clear');
    b.emit('wb_clear');
    const clr = await clrP;
    check('wb_clear 广播给所有人', typeof clr.author === 'string');
    const state5 = await wbJoin(c);
    check('清空后历史为空', state5.strokes.length === 0);

    console.log('【实时光标】');
    const cur1P = waitEvent(b, 'wb_cursor');
    a.emit('wb_cursor', { x: 0.5, y: 0.6 });
    const cur1 = await cur1P;
    check('光标中继含身份/颜色/坐标', cur1.id === a.id && typeof cur1.nickname === 'string' &&
      /^#[0-9a-f]{6}$/i.test(cur1.color) && cur1.x === 0.5 && cur1.y === 0.6, JSON.stringify(cur1));
    await sleep(30); // 避开服务器 15ms 限频窗口
    const cur2P = waitEvent(b, 'wb_cursor');
    a.emit('wb_cursor', { x: 2, y: -1 });
    const cur2 = await cur2P;
    check('光标坐标越界钳制', cur2.x === 1 && cur2.y === 0);

    // 限频：50ms 静默后瞬时连发 3 个，只能过 1 个
    await sleep(50);
    let spamCount = 0;
    const spamHandler = () => { spamCount++; };
    b.on('wb_cursor', spamHandler);
    a.emit('wb_cursor', { x: 0.1, y: 0.1 });
    a.emit('wb_cursor', { x: 0.2, y: 0.2 });
    a.emit('wb_cursor', { x: 0.3, y: 0.3 });
    await sleep(300);
    b.off('wb_cursor', spamHandler);
    check('高频光标包被限频(3→1)', spamCount === 1, `实际收到 ${spamCount}`);

    // 新加入者能看到在线光标
    const d2 = await connectSocket();
    const st1 = await wbJoin(d2);
    check('wb_join 含他人光标', Array.isArray(st1.cursors) &&
      st1.cursors.some((k) => k.id === a.id && typeof k.x === 'number'), JSON.stringify(st1.cursors));

    // 主动离开 → 广播 + join 不再包含
    const lv1P = waitEvent(b, 'wb_cursor_leave');
    a.emit('wb_cursor_leave');
    const lv1 = await lv1P;
    check('主动离开广播光标消失', lv1.id === a.id);
    const st2 = await wbJoin(d2);
    check('离开后 join 不再含该光标', !st2.cursors.some((k) => k.id === a.id));

    // 断线 → 服务器自动广播离开
    d2.emit('wb_cursor', { x: 0.3, y: 0.3 });
    await sleep(100);
    const d2Id = d2.id; // disconnect() 后 socket.io-client 会清空 id，先保存
    const lv2P = waitEvent(b, 'wb_cursor_leave');
    d2.disconnect();
    const lv2 = await lv2P;
    check('断线自动广播光标离开', lv2.id === d2Id, `got ${lv2.id}, want ${d2Id}`);

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
