/* 公网邀请审核模式集成测试（真实服务器 + socket.io-client + fetch）：
 * 实例A（invite 模式，本机管理员）：状态查询 / 无效邀请码 / 申请 / 邀请码一次性与占名 /
 *   未审批登录失败 / 无会话连接被拒 / 申请列表(带IP) / 审批通过 / 登录 / 带会话连接 /
 *   HTTP 门禁(401/放行) / 封禁后重连被拒 / 同 IP 注册上限 / 拒绝申请 / 登出。
 * 实例B（invite 模式，模拟远程）：LOCAL_ADDRS 不含本机 → 管理操作被拒 / admin_login 口令校验。
 * 实例C（off 模式回归）：匿名连接不受影响，/api/auth/status 返回 mode:'off'。 */
'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT_A = 3110, PORT_B = 3111, PORT_C = 3112;
const BASE_A = `https://127.0.0.1:${PORT_A}`;
const BASE_B = `https://127.0.0.1:${PORT_B}`;
const BASE_C = `https://127.0.0.1:${PORT_C}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('服务器启动超时')); } }, 8000);
    proc.stdout.on('data', (d) => {
      const s = String(d);
      if (s.includes('已启动')) { if (!done) { done = true; clearTimeout(timer); resolve(proc); } }
    });
  });
}

async function api(base, p, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(base + p, {
      ...(opts || {}),
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...((opts && opts.headers) || {}) }
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* 非 JSON */ }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function connectSocket(base, authPayload, extraHeaders) {
  return new Promise((resolve, reject) => {
    const s = io(base, {
      rejectUnauthorized: false, transports: ['websocket'],
      auth: authPayload || {},
      ...(extraHeaders ? { extraHeaders } : {})
    });
    const t = setTimeout(() => reject(new Error('connect timeout')), 5000);
    s.on('welcome', (w) => { clearTimeout(t); resolve({ s, id: w.id, nickname: w.nickname, welcome: w }); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    s.on('auth_required', () => { /* 预认证态场景用 waitEvent 捕获 */ });
  });
}

// 预认证态连接：不带会话，等 auth_required 事件（远端匿名/远程管理员登录用）
function connectPreAuth(base) {
  return new Promise((resolve, reject) => {
    const s = io(base, { rejectUnauthorized: false, transports: ['websocket'] });
    const t = setTimeout(() => reject(new Error('pre-auth connect timeout')), 5000);
    s.on('auth_required', (d) => { clearTimeout(t); resolve({ s, info: d }); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    s.on('welcome', () => { clearTimeout(t); reject(new Error('预认证态不应收到 welcome')); });
  });
}

function waitEvent(sock, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

function socketEmit(sock, event, data) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'socketEmit 超时' }), 3000);
    sock.emit(event, data, (res) => { clearTimeout(t); resolve(res); });
  });
}

async function main() {
  const tmpDb = (n) => path.join(__dirname, `.auth-${n}.db`);
  for (const n of ['a', 'b', 'c']) { try { fs.rmSync(tmpDb(n), { force: true }); } catch (_) {} }

  console.log('=== 实例A：invite 模式（本机管理员） ===');
  const procA = await startServer(PORT_A, {
    LOCALSEND_DB_FILE: tmpDb('a'),
    LOCALSEND_PUBLIC_MODE: 'invite',
    LOCALSEND_ADMIN_PASSWORD: 'admin-secret'
  });

  try {
    // 1. 状态查询
    let r = await api(BASE_A, '/api/auth/status');
    check('status: mode=invite authed=false', r.status === 200 && r.body.mode === 'invite' && r.body.authed === false);

    // 2. 无效邀请码申请
    r = await api(BASE_A, '/api/join', { method: 'POST', body: JSON.stringify({ code: 'XXXXX-XXXXX', username: 'alice', password: 'secret123', nickname: '小A' }) });
    check('无效邀请码被拒', r.status === 400 && /无效/.test(r.body.error || ''));

    // 3. 缺少邀请码
    r = await api(BASE_A, '/api/join', { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'secret123' }) });
    check('缺少邀请码被拒', r.status === 400 && /缺少/.test(r.body.error || ''));

    // 4. 管理员创建邀请码（本机直连：LAN 式匿名引导）
    const adminS = await connectSocket(BASE_A);
    let inv = await socketEmit(adminS.s, 'admin_invites', { action: 'create', maxUses: 2, note: '测试邀请' });
    check('创建邀请码', inv.ok === true && /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(inv.code || ''));
    const code = inv.code;

    // 5. 正常申请
    r = await api(BASE_A, '/api/join', { method: 'POST', body: JSON.stringify({ code, username: 'alice', password: 'secret123', nickname: '小A' }) });
    check('正常申请入 pending', r.status === 200 && r.body.ok === true && r.body.id > 0);

    // 6. 重名被拒（邀请码仍有名额 → 走用户名占用检查）
    r = await api(BASE_A, '/api/join', { method: 'POST', body: JSON.stringify({ code, username: 'alice', password: 'other123' }) });
    check('重名申请被拒', r.status === 400 && /占用/.test(r.body.error || ''));

    // 7. 第二人正常申请（占满名额）
    r = await api(BASE_A, '/api/join', { method: 'POST', body: JSON.stringify({ code, username: 'bob', password: 'secret123', nickname: '小B' }) });
    check('第二个申请入 pending', r.status === 200 && r.body.ok === true);

    // 8. 名额用尽：第三份申请被拒
    r = await api(BASE_A, '/api/join', { method: 'POST', body: JSON.stringify({ code, username: 'carol', password: 'secret123' }) });
    check('邀请码名额用尽被拒', r.status === 400 && /用完/.test(r.body.error || ''));

    // 9. 未审批登录失败
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'secret123' }) });
    check('未审批登录失败', r.status === 401);

    // 10. 宿主机直连豁免：匿名连接按 LAN 方式进入（引导用）
    const hostAnon = await connectSocket(BASE_A);
    check('宿主机直连匿名可进（引导）', hostAnon.nickname.startsWith('用户'));
    hostAnon.s.close();

    // 11. 申请列表（含 IP）
    inv = await socketEmit(adminS.s, 'admin_applications', {});
    check('申请列表 2 条且带 IP', inv.ok === true && inv.applications.length === 2 && inv.applications[0].username === 'bob' && inv.applications[0].ip);
    const aliceApp = inv.applications.find((a) => a.username === 'alice');
    const bobApp = inv.applications.find((a) => a.username === 'bob');

    // 12. 审批通过 alice
    inv = await socketEmit(adminS.s, 'admin_approve', { id: aliceApp.id });
    check('审批通过生成账号', inv.ok === true && /^u_/.test(inv.userId || '') && inv.username === 'alice');
    const aliceUserId = inv.userId;

    // 13. 登录成功
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'secret123' }) });
    check('登录成功返回 token', r.status === 200 && r.body.ok === true && r.body.token && r.body.user.username === 'alice');
    const token = r.body.token;

    // 14. 带 token 状态查询
    r = await api(BASE_A, '/api/auth/status', { headers: { authorization: `Bearer ${token}` } });
    check('带 token status: authed=true', r.body.authed === true && r.body.user.id === aliceUserId);

    // 15. 带会话 socket 连接（X-Forwarded-For 模拟远程），身份为账号
    const remoteXff = { 'x-forwarded-for': '203.0.113.9' };
    const aliceS = await connectSocket(BASE_A, { sessionToken: token }, remoteXff);
    check('带会话连接成功，昵称/身份为账号', aliceS.nickname === '小A' && aliceS.welcome.clientId === aliceUserId);
    // 发一条消息（chat_message 无 ack，改为在管理端验证广播）
    const gotMsgP = waitEvent(adminS.s, 'chat_message');
    aliceS.s.emit('chat_message', { text: '公网测试消息', timestamp: Date.now() });
    const gotMsg = await gotMsgP.catch(() => null);
    check('登录用户可发消息（广播含昵称）', !!gotMsg && gotMsg.text === '公网测试消息' && gotMsg.nickname === '小A');

    // 16. HTTP 门禁（用 X-Forwarded-For 模拟远程）：数据路由 401 / 放行；页面壳放行
    const remoteHdr = { 'x-forwarded-for': '203.0.113.9' };
    r = await api(BASE_A, '/api/calendar/year?year=2026', { headers: remoteHdr });
    check('HTTP 门禁：远程无会话 401', r.status === 401);
    r = await api(BASE_A, '/api/calendar/year?year=2026', { headers: { ...remoteHdr, authorization: `Bearer ${token}` } });
    check('HTTP 门禁：远程带会话放行', r.status === 200);
    r = await api(BASE_A, '/', { headers: remoteHdr });
    check('页面壳放行（未认证可加载登录壳）', r.status === 200);

    // 17. 封禁：旧连接断开，重连被拒（先挂监听再踢，避免事件先于监听到达）
    const discP = waitEvent(aliceS.s, 'disconnect');
    await socketEmit(adminS.s, 'admin_kick', { clientId: aliceUserId });
    const bannedDisc = await discP.catch(() => null);
    check('封禁后旧连接被断开', !!bannedDisc);
    const bannedRe = io(BASE_A, { rejectUnauthorized: false, transports: ['websocket'], auth: { sessionToken: token }, extraHeaders: remoteXff });
    const bannedMsg = await waitEvent(bannedRe, 'system_message').catch(() => null);
    await waitEvent(bannedRe, 'disconnect').catch(() => null);
    check('封禁后重连被拒', !!bannedMsg && /移出/.test(bannedMsg.text || ''));

    // 18. 同 IP 注册上限（ipRegLimit 默认 2：alice 已建号 + bob pending = 2 → carol 被拒）
    inv = await socketEmit(adminS.s, 'admin_invites', { action: 'create', maxUses: 1 });
    const code2 = inv.code;
    r = await api(BASE_A, '/api/join', { method: 'POST', body: JSON.stringify({ code: code2, username: 'carol', password: 'secret123' }) });
    check('同 IP 注册超限被拒（上限 2）', r.status === 400 && /上限/.test(r.body.error || ''));

    // 19. 拒绝申请
    inv = await socketEmit(adminS.s, 'admin_reject', { id: bobApp.id, reason: '满员' });
    check('拒绝申请成功', inv.ok === true);

    // 19. 登出
    r = await api(BASE_A, '/api/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    check('登出成功', r.status === 200 && r.body.ok === true);
    r = await api(BASE_A, '/api/auth/status', { headers: { authorization: `Bearer ${token}` } });
    check('登出后会话失效', r.body.authed === false);

    // 20. 邀请码列表带 applied
    inv = await socketEmit(adminS.s, 'admin_invites', {});
    check('邀请码列表含已用计数', inv.ok === true && inv.invites.length >= 2 && inv.invites.some((i) => i.applied >= 1));

    adminS.s.close();
    aliceS.s.close();
  } catch (e) {
    failures++;
    console.error('  实例A 异常:', e.message);
  } finally {
    procA.kill();
    await sleep(300);
  }

  console.log('=== 实例B：invite 模式（模拟远程管理员，口令登录） ===');
  const procB = await startServer(PORT_B, {
    LOCALSEND_DB_FILE: tmpDb('b'),
    LOCALSEND_PUBLIC_MODE: 'invite',
    LOCALSEND_ADMIN_PASSWORD: 'admin-secret',
    LOCALSEND_LOCAL_ADDRS: '10.255.255.1' // 不含 127.0.0.1 → 模拟公网远程
  });
  try {
    const remote = await connectPreAuth(BASE_B);
    // 无口令：管理操作被拒
    let r = await socketEmit(remote.s, 'admin_users', {});
    check('远程无口令管理被拒', r.ok === false);
    // 错误口令
    r = await socketEmit(remote.s, 'admin_login', { password: 'wrong' });
    check('错误口令被拒', r.ok === false);
    // 正确口令
    r = await socketEmit(remote.s, 'admin_login', { password: 'admin-secret' });
    check('正确口令远程管理生效', r.ok === true && r.remote === true);
    r = await socketEmit(remote.s, 'admin_users', {});
    check('口令后管理操作放行', r.ok === true && Array.isArray(r.users));
    // 邀请模式 + 本机判定为远程：create invite 也应可用
    r = await socketEmit(remote.s, 'admin_invites', { action: 'create', maxUses: 1 });
    check('远程可创建邀请码', r.ok === true && r.code);
    remote.s.close();
  } catch (e) {
    failures++;
    console.error('  实例B 异常:', e.message);
  } finally {
    procB.kill();
    await sleep(300);
  }

  console.log('=== 实例C：off 模式回归（LAN 行为不变） ===');
  const procC = await startServer(PORT_C, { LOCALSEND_DB_FILE: tmpDb('c') });
  try {
    const anon = await connectSocket(BASE_C);
    check('off 模式匿名连接正常', anon.nickname.startsWith('用户'));
    const r = await api(BASE_C, '/api/auth/status');
    check('status: mode=off', r.body.mode === 'off');
    // 匿名 HTTP 访问不受门禁影响
    const r2 = await api(BASE_C, '/api/calendar/year?year=2026');
    check('off 模式 HTTP 不受门禁', r2.status === 200);
    anon.s.close();
  } catch (e) {
    failures++;
    console.error('  实例C 异常:', e.message);
  } finally {
    procC.kill();
    await sleep(300);
  }

  for (const n of ['a', 'b', 'c']) { try { fs.rmSync(tmpDb(n), { force: true }); } catch (_) {} }

  console.log(failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
