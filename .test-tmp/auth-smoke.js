/* 公网邀请审核模式集成测试（真实服务器 + socket.io-client + fetch）：
 * 实例A（invite 模式，本机管理员）：状态查询 / 无效邀请码 / 申请 / 邀请码一次性与占名 /
 *   未审批登录失败 / 无会话连接被拒 / 申请列表(带IP) / 审批通过 / 登录 / 带会话连接 /
 *   HTTP 门禁(401/放行) / 封禁后重连被拒 / 同 IP 注册上限 / 拒绝申请 / 登出 /
 *   XFF 末段防伪造(同 IP 上限按末段计数) / 管理员账号(授权→远程读改配置→socket 免口令管理→降权吊销会话) /
 *   每人上传配额(超限拒绝/放行) / 改密(旧密码→吊销会话→新密码登录) / 管理员重置(宿主机+远程管理员) /
 *   配额可视化(账号列表带已用字节)。
 * 实例B（invite 模式，模拟远程）：LOCAL_ADDRS 不含本机 → 管理操作被拒 / admin_login 口令校验。
 * 实例C（off 模式回归）：匿名连接不受影响，/api/auth/status 返回 mode:'off'。 */
'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const sqlite = require('better-sqlite3');

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

// 文件上传（multipart）：携带会话 token + 模拟远程 XFF
async function uploadFile(base, { token, xff, clientId, nickname, name, size, room }) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.alloc(size, 0x61)]), name || 'q.txt');
  fd.append('clientId', clientId || '');
  fd.append('room', room || 'main');
  fd.append('nickname', nickname || '测试');
  const res = await fetch(base + '/upload', {
    method: 'POST',
    body: fd,
    headers: {
      ...(xff ? { 'x-forwarded-for': xff } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, body };
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
  try { fs.rmSync(path.join(__dirname, '.auth-a-uploads'), { recursive: true, force: true }); } catch (_) {}
  const tmpConfigA = path.join(__dirname, '.auth-config.json');
  try { fs.rmSync(tmpConfigA, { force: true }); } catch (_) {}

  console.log('=== 实例A：invite 模式（本机管理员） ===');
  const procA = await startServer(PORT_A, {
    LOCALSEND_DB_FILE: tmpDb('a'),
    LOCALSEND_UPLOAD_DIR: path.join(__dirname, '.auth-a-uploads'), // 上传目录隔离，避免污染真实数据
    LOCALSEND_PUBLIC_MODE: 'invite',
    LOCALSEND_ADMIN_PASSWORD: 'admin-secret',
    LOCALSEND_CONFIG_FILE: tmpConfigA,          // 配置读写隔离到临时文件
    LOCALSEND_PER_USER_UPLOAD_MB: '0.05',       // 每人上传配额 50KB，验证配额拒绝
    LOCALSEND_MAX_UPLOAD_MB: '1',               // uploads 容量上限 1MB，让磁盘水位有可测的分母
    LOCALSEND_TURN_SERVERS: '[{"urls":"turn:127.0.0.1:3478","username":"u","credential":"p"},{"urls":"stun:stun.l.google.com:19302"}]'
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
    check('TURN 下发：welcome 带解析后的 ICE 服务器列表', Array.isArray(adminS.welcome.iceServers)
      && adminS.welcome.iceServers.length === 2
      && adminS.welcome.iceServers[0].urls === 'turn:127.0.0.1:3478');
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

    // 17. 封禁：旧连接断开，会话被吊销，重连被拒（先挂监听再踢，避免事件先于监听到达）
    const discP = waitEvent(aliceS.s, 'disconnect');
    await socketEmit(adminS.s, 'admin_kick', { clientId: aliceUserId });
    const bannedDisc = await discP.catch(() => null);
    check('封禁后旧连接被断开', !!bannedDisc);
    const bannedRe = io(BASE_A, { rejectUnauthorized: false, transports: ['websocket'], auth: { sessionToken: token }, extraHeaders: remoteXff });
    const bannedAuth = await waitEvent(bannedRe, 'auth_required').catch(() => null);
    check('封禁后会话吊销，重连被拒（auth_required）', !!bannedAuth && /登录/.test(bannedAuth.error || ''));
    bannedRe.close();

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

    // 21. XFF 末段防伪造：客户端伪造前缀段不影响同 IP 上限计数（真实 IP 由可信反代追加在末段）
    inv = await socketEmit(adminS.s, 'admin_invites', { action: 'create', maxUses: 3 });
    const code3 = inv.code;
    const forged = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }; // 伪造前缀 + 真实 IP 203.0.113.9
    r = await api(BASE_A, '/api/join', { method: 'POST', headers: forged, body: JSON.stringify({ code: code3, username: 'carol', password: 'secret123', nickname: '小C' }) });
    check('申请（XFF 伪造前缀）入 pending', r.status === 200 && r.body.ok === true && r.body.id > 0);
    const carolAppId = r.body.id;
    r = await api(BASE_A, '/api/join', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ code: code3, username: 'dave', password: 'secret123' }) });
    check('第二份申请（同真实 IP）入 pending', r.status === 200 && r.body.ok === true);
    r = await api(BASE_A, '/api/join', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ code: code3, username: 'erin', password: 'secret123' }) });
    // 若误取首段，carol 会被记为 6.6.6.6，本申请将成功 → 此断言即捕获 XFF 伪造漏洞
    check('第三份同 IP 申请被拒（末段计数）', r.status === 400 && /上限/.test(r.body.error || ''));

    // 22. 管理员账号：host 授予 carol 管理员 → 重新登录后获得 socket 管理 + HTTP 配置读写权
    inv = await socketEmit(adminS.s, 'admin_approve', { id: carolAppId });
    check('审批 carol 生成账号', inv.ok === true && /^u_/.test(inv.userId || ''));
    const carolUserId = inv.userId;
    inv = await socketEmit(adminS.s, 'admin_set_role', { username: 'carol', role: 'admin' });
    check('授予 carol 管理员权限', inv.ok === true && inv.role === 'admin');
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'carol', password: 'secret123' }) });
    check('carol 重新登录成功', r.status === 200 && r.body.token);
    const token2 = r.body.token;
    r = await api(BASE_A, '/api/config', { headers: { ...remoteHdr, authorization: `Bearer ${token2}` } });
    check('管理员账号可远程读配置', r.status === 200 && r.body.ok === true && r.body.config && typeof r.body.config.msgRateLimit === 'number');
    r = await api(BASE_A, '/api/config', { method: 'POST', headers: { ...remoteHdr, authorization: `Bearer ${token2}` }, body: JSON.stringify({ config: { msgRateLimit: 5 } }) });
    check('管理员账号可远程改配置', r.status === 200 && r.body.ok === true);
    r = await api(BASE_A, '/api/config', { headers: { ...remoteHdr, authorization: `Bearer ${token2}` } });
    check('配置变更即时生效（msgRateLimit=5）', r.body.config.msgRateLimit === 5);
    r = await api(BASE_A, '/api/config', { method: 'POST', headers: { ...remoteHdr, authorization: `Bearer ${token2}` }, body: JSON.stringify({ config: { msgRateLimit: 12 } }) });
    check('还原配置', r.status === 200 && r.body.ok === true);
    const carolS = await connectSocket(BASE_A, { sessionToken: token2 }, remoteXff);
    inv = await socketEmit(carolS.s, 'admin_invites', { action: 'create', maxUses: 1 });
    check('管理员账号 socket 管理免口令（admin_invites）', inv.ok === true && inv.code);
    carolS.s.close();

    // 23. 每人上传配额（perUserUploadMB=0.05MB）：超限拒绝，未超放行
    r = await uploadFile(BASE_A, { token: token2, xff: '203.0.113.9', clientId: carolUserId, nickname: '小C', name: 'big.txt', size: 60 * 1024 });
    check('上传超配额被拒', r.status === 403 && /配额/.test((r.body && r.body.error) || ''));
    r = await uploadFile(BASE_A, { token: token2, xff: '203.0.113.9', clientId: carolUserId, nickname: '小C', name: 'small.txt', size: 5 * 1024 });
    check('配额内上传成功', r.status === 200 && r.body.ok === true);
    // 单文件未超配额但累计超限（已用 5KB + 本次 50KB > 52KB）→ 证明按累计字节计数
    r = await uploadFile(BASE_A, { token: token2, xff: '203.0.113.9', clientId: carolUserId, nickname: '小C', name: 'cum.txt', size: 50 * 1024 });
    check('累计超配额被拒（单文件未超）', r.status === 403 && /配额/.test((r.body && r.body.error) || ''));
    // 磁盘水位：uploads 容量水位 > 0（相对 maxUploadMB），数据面板据此提示
    // 注：history_stats 处理器签名仅 (cb)，需直接只带回调调用
    inv = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: '超时' }), 3000);
      adminS.s.emit('history_stats', (res) => { clearTimeout(t); resolve(res); });
    });
    check('磁盘水位上报（quotaPct>0）', inv.ok === true && inv.disk && typeof inv.disk.quotaPct === 'number' && inv.disk.quotaPct > 0);

    // 24. 收回管理员：会话被吊销 → 配置接口立即失效
    inv = await socketEmit(adminS.s, 'admin_set_role', { username: 'carol', role: 'user' });
    check('收回 carol 管理员权限', inv.ok === true && inv.role === 'user');
    r = await api(BASE_A, '/api/config', { headers: { ...remoteHdr, authorization: `Bearer ${token2}` } });
    check('降权后旧会话立即失效（配置 401）', r.status === 401);
    r = await api(BASE_A, '/api/auth/status', { headers: { authorization: `Bearer ${token2}` } });
    check('降权后旧会话已吊销（status authed=false）', r.body.authed === false);

    // 25. 改密 / 管理员重置：dave 走完整链路
    inv = await socketEmit(adminS.s, 'admin_applications', {});
    const daveApp = inv.applications.find((a) => a.username === 'dave');
    inv = await socketEmit(adminS.s, 'admin_approve', { id: daveApp.id });
    check('审批 dave 生成账号', inv.ok === true);
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'dave', password: 'secret123' }) });
    check('dave 登录成功', r.status === 200 && r.body.token);
    const tokenD1 = r.body.token;
    r = await api(BASE_A, '/api/password/change', { method: 'POST', headers: remoteHdr, body: JSON.stringify({ username: 'dave', oldPassword: 'secret123', newPassword: 'newsecret456' }) });
    check('本人改密成功（凭旧密码）', r.status === 200 && r.body.ok === true);
    r = await api(BASE_A, '/api/auth/status', { headers: { authorization: `Bearer ${tokenD1}` } });
    check('改密后旧会话全部吊销', r.body.authed === false);
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'dave', password: 'secret123' }) });
    check('旧密码登录被拒', r.status === 401);
    // 登录失败审计：DB 落一条 login_fail，但默认审计视图过滤掉（防刷屏）
    try {
      const dbA = sqlite(tmpDb('a'));
      const failCnt = dbA.prepare(`SELECT COUNT(*) c FROM audit_log WHERE action = 'login_fail'`).get().c;
      dbA.close();
      check('登录失败已记入审计表', failCnt >= 1);
    } catch (e) {
      check('登录失败已记入审计表', false, e.message);
    }
    inv = await socketEmit(adminS.s, 'admin_audit', {});
    check('默认审计视图过滤登录失败(防刷屏)', Array.isArray(inv.entries) && inv.entries.every((x) => x.action !== 'login_fail'));
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'dave', password: 'newsecret456' }) });
    check('新密码登录成功', r.status === 200 && r.body.token);
    // 管理员重置（宿主机直连）：被重置账号会话全部失效
    r = await api(BASE_A, '/api/password/reset', { method: 'POST', body: JSON.stringify({ username: 'dave', newPassword: 'resetpass789' }) });
    check('宿主机可重置密码', r.status === 200 && r.body.ok === true);
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'dave', password: 'resetpass789' }) });
    check('重置后的新密码可登录', r.status === 200 && r.body.token);
    // 管理员账号远程重置：重新授予 carol 管理员 → 远程重置 dave
    inv = await socketEmit(adminS.s, 'admin_set_role', { username: 'carol', role: 'admin' });
    check('重新授予 carol 管理员', inv.ok === true);
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'carol', password: 'secret123' }) });
    const tokenC2 = r.status === 200 ? r.body.token : '';
    r = await api(BASE_A, '/api/password/reset', { method: 'POST', headers: { ...remoteHdr, authorization: `Bearer ${tokenC2}` }, body: JSON.stringify({ username: 'dave', newPassword: 'adminreset1' }) });
    check('管理员账号远程重置密码', r.status === 200 && r.body.ok === true);
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'dave', password: 'adminreset1' }) });
    check('远程重置后的新密码可登录', r.status === 200 && r.body.token);
    // 非管理员远程重置被拒（无会话→门禁 401；带普通账号会话→403）
    r = await api(BASE_A, '/api/password/reset', { method: 'POST', headers: remoteHdr, body: JSON.stringify({ username: 'dave', newPassword: 'hack12345' }) });
    check('非管理员远程重置被拒', r.status === 401 || r.status === 403);
    // socket 版重置（口令型/宿主/账号管理员共用通道）
    inv = await socketEmit(adminS.s, 'admin_reset_password', { username: 'dave', newPassword: 'socketreset2' });
    check('socket 版重置密码', inv.ok === true);
    r = await api(BASE_A, '/api/login', { method: 'POST', body: JSON.stringify({ username: 'dave', password: 'socketreset2' }) });
    check('socket 重置后新密码可登录', r.status === 200 && r.body.token);

    // 26. 配额可视化：admin_accounts 带每人已用字节（carol 之前传过 5KB）
    inv = await socketEmit(adminS.s, 'admin_accounts', {});
    check('账号列表带已用字节', inv.ok === true && inv.users.every((u) => typeof u.usedBytes === 'number'));
    check('配额可视化：carol 已用 > 0', inv.users.some((u) => u.username === 'carol' && u.usedBytes > 0));

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
    check('未配 TURN 时 welcome 不下发 ICE 列表', Array.isArray(anon.welcome.iceServers) && anon.welcome.iceServers.length === 0);
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
  try { fs.rmSync(tmpConfigA, { force: true }); } catch (_) {}
  try { fs.rmSync(path.join(__dirname, '.auth-a-uploads'), { recursive: true, force: true }); } catch (_) {}

  console.log(failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
