/* 公网邀请模式认证核心（publicMode='invite' 时启用；'off' 时全部旁路，LAN 行为不变）：
 *  - 密码 scrypt 哈希（零第三方依赖）、会话（内存态，30 天有效）
 *  - 邀请码生成/校验、加入申请提交/审批（申请 -> 账号）
 *  - 登录 / 管理员远程口令（timing-safe 比较）
 *  - Express 门禁中间件 + IP 提取（兼容反代 X-Forwarded-For）
 * 供 routes-auth（HTTP）、server.js（Socket 握手身份）、rt-admin（审批）复用。 */
'use strict';
const crypto = require('crypto');
const store = require('../db.js');
const state = require('./state');
const { isLocalAddr } = require('./util');
const { PUBLIC_MODE, ADMIN_PASSWORD, IP_REG_LIMIT, SESSION_TTL_MS } = require('./config');

const inviteEnabled = () => PUBLIC_MODE === 'invite';

// ---------- 密码哈希（scrypt；返回 salt:hash 十六进制） ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  try {
    const s = String(stored || '');
    const idx = s.indexOf(':');
    if (idx <= 0) return false;
    const want = Buffer.from(s.slice(idx + 1), 'hex');
    const got = crypto.scryptSync(String(pw), s.slice(0, idx), 64);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch (_) { return false; }
}

// ---------- 会话（内存态；重启后需重新登录） ----------
function issueSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  state.sessions.set(token, {
    userId: user.id, username: user.username,
    nickname: user.nickname || user.username, role: user.role || 'user',
    createdAt: Date.now()
  });
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const s = state.sessions.get(String(token));
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) { state.sessions.delete(String(token)); return null; }
  return s;
}

function revokeSession(token) {
  if (token) state.sessions.delete(String(token));
}

// 账号是否被封禁（封禁表由 loadBannedUsersFromDb 载入，key = 账号 id）
function isUserBanned(userId) {
  return !!userId && state.bans.has(String(userId));
}

// 吊销某账号的全部会话（降权 / 封禁时调用，防止旧会话继续以管理员身份或已封禁身份使用）
function revokeUserSessions(userId) {
  const id = String(userId || '');
  if (!id) return;
  for (const [token, s] of state.sessions) {
    if (String(s.userId) === id) state.sessions.delete(token);
  }
}

// ---------- IP 提取（反代场景读 X-Forwarded-For 末段，直连退回 socket 地址） ----------
// 注意取「末段」：可信反代把真实 IP 追加在链尾，客户端伪造的前缀段一律忽略（防伪造审计 IP / 绕 IP 上限）。
function clientIp(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (xff) { const parts = String(xff).split(','); const f = parts[parts.length - 1].trim(); if (f) return f; }
  return (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
}

function socketIp(socket) {
  const xff = socket && socket.handshake && socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
  if (xff) { const parts = String(xff).split(','); const f = parts[parts.length - 1].trim(); if (f) return f; }
  return (socket && socket.handshake && socket.handshake.address) || '';
}

// ---------- 宿主机直连判定（本机可信，绕过会话门禁；用于引导与管理兜底） ----------
// 注意：必须同时满足"无 X-Forwarded-For"（未经过反代）与"来源地址为本机"。
// 反代场景下所有请求从本机回环进入，若只查 socket 地址会把远程用户误判为本机 → 必须看 XFF。
function isDirectLocalSocket(socket) {
  const h = (socket && socket.handshake) || {};
  const xff = h.headers && h.headers['x-forwarded-for'];
  if (xff && String(xff).trim()) return false;
  return isLocalAddr(h.address);
}

function isDirectLocalReq(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (xff && String(xff).trim()) return false;
  return isLocalAddr(req && (req.socket && req.socket.remoteAddress));
}

// ---------- 邀请码 ----------
// 去除易混淆字符（0/O/1/I）的类 base32，形如 ABCDE-FGHJK
function genInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s.slice(0, 5) + '-' + s.slice(5);
}

// 校验邀请码是否可用于新申请：存在 / 未过期 / 未超用（pending+approved 合计）
function validateInvite(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return { ok: false, error: '缺少邀请码' };
  const inv = store.getInvite(c);
  if (!inv) return { ok: false, error: '邀请码无效' };
  if (inv.expiresAt && inv.expiresAt < Date.now()) return { ok: false, error: '邀请码已过期' };
  if (store.applicationCountByInvite(c) >= inv.maxUses) return { ok: false, error: '邀请码使用次数已用完' };
  return { ok: true, code: c, invite: inv };
}

// ---------- 加入申请 ----------
function submitApplication({ code, username, password, nickname, ip, ua }) {
  const v = validateInvite(code);
  if (!v.ok) return v;
  const user = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(user)) return { ok: false, error: '用户名需为 3~24 位字母/数字/._-' };
  if (store.usernameTaken(user)) return { ok: false, error: '用户名已被占用' };
  if (!password || String(password).length < 6) return { ok: false, error: '密码至少 6 位' };
  if (String(password).length > 128) return { ok: false, error: '密码过长' };
  const nick = String(nickname || '').trim().slice(0, 20) || user;
  // 同 IP 上限（已建账号 + 未决申请合计，防一人多号/刷申请）
  if (IP_REG_LIMIT > 0 && ip) {
    const total = store.countUsersByIp(ip) + store.countPendingByIp(ip);
    if (total >= IP_REG_LIMIT) return { ok: false, error: `该 IP 已达 ${IP_REG_LIMIT} 个账号上限` };
  }
  const id = store.insertJoinApplication({
    inviteCode: v.code, username: user, passHash: hashPassword(password),
    nickname: nick, ip: ip || '', ua: String(ua || '').slice(0, 300), createdAt: Date.now()
  });
  return { ok: true, id };
}

// 审批通过：申请 -> 账号 + 邀请码计数；返回 { ok, userId?, username?, error? }
function approveApplication(id, reviewer) {
  const app = store.getJoinApplication(Number(id) || 0);
  if (!app) return { ok: false, error: '申请不存在' };
  if (app.status !== 'pending') return { ok: false, error: '该申请已处理过' };
  // 只查已建账号（申请者自己的 pending 记录不算占用）
  if (store.getUserByUsername(app.username)) return { ok: false, error: '用户名已被占用，请拒绝并让用户重新申请' };
  const userId = 'u_' + crypto.randomBytes(8).toString('hex');
  store.insertUser({
    id: userId, username: app.username, passHash: app.passHash,
    nickname: app.nickname || app.username, role: 'user',
    createdIp: app.ip, createdAt: Date.now()
  });
  store.setApplicationStatus(app.id, 'approved', reviewer || '', '');
  store.bumpInviteUsed(app.inviteCode);
  return { ok: true, userId, username: app.username };
}

function rejectApplication(id, reviewer, reason) {
  const app = store.getJoinApplication(Number(id) || 0);
  if (!app) return { ok: false, error: '申请不存在' };
  if (app.status !== 'pending') return { ok: false, error: '该申请已处理过' };
  store.setApplicationStatus(app.id, 'rejected', reviewer || '', String(reason || '').slice(0, 200));
  return { ok: true };
}

// ---------- 启动恢复 ----------
// 把 users.banned=1 的账号载入封禁表（跨重启持续封禁；连接层按 clientId 校验）
function loadBannedUsersFromDb() {
  try {
    for (const u of store.listUsers()) {
      if (u.banned && !state.bans.has(u.id)) {
        state.bans.set(u.id, { nickname: u.nickname || '', at: u.createdAt || Date.now() });
      }
    }
  } catch (_) { /* DB 不可用不阻塞 */ }
}

// ---------- 登录 / 管理员口令 ----------
function login(username, password) {
  const u = store.getUserByUsername(String(username || '').trim());
  if (!u || !verifyPassword(password, u.passHash)) return { ok: false, error: '用户名或密码错误' };
  if (u.banned) return { ok: false, error: '该账号已被封禁' };
  return { ok: true, user: u, token: issueSession(u) };
}

function publicUser(u) {
  return { id: u.id, username: u.username, nickname: u.nickname, role: u.role };
}

// 管理员远程口令（timing-safe；空口令 = 禁用远程管理）
function checkAdminPassword(pw) {
  if (!ADMIN_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const remoteAdminEnabled = () => !!ADMIN_PASSWORD;

// ---------- Express 门禁（invite 模式：只门禁数据路由；页面壳放行，未认证连接由客户端跳转登录页） ----------
const PUBLIC_PATHS = new Set(['/api/join', '/api/login', '/api/logout', '/api/auth/status']);
const GATED_PREFIXES = ['/api/', '/images/', '/download/', '/upload', '/data-export'];
function authMiddleware(req, res, next) {
  if (!inviteEnabled()) return next();
  if (isDirectLocalReq(req)) return next(); // 宿主机直连（未过反代）信任豁免
  const pathname = String(req.path || req.url || '').split('?')[0];
  if (PUBLIC_PATHS.has(pathname)) return next();
  if (!GATED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) return next(); // 静态页面/资源
  const sess = extractToken(req) && validateSession(extractToken(req));
  if (sess && isUserBanned(sess.userId)) {
    revokeSession(extractToken(req));
    return res.status(401).json({ ok: false, error: '该账号已被封禁' });
  }
  if (sess) return next();
  res.status(401).json({ ok: false, error: '未登录或会话已过期' });
}

// 从 Authorization: Bearer 头或 ls_session cookie 提取会话 token
function extractToken(req) {
  const h = req.headers && req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const c = req.headers && req.headers.cookie;
  if (c) {
    const m = /(?:^|;\s*)ls_session=([^;]+)/.exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return '';
}

module.exports = {
  inviteEnabled, hashPassword, verifyPassword,
  issueSession, validateSession, revokeSession, revokeUserSessions, isUserBanned,
  clientIp, socketIp, isDirectLocalSocket, isDirectLocalReq,
  genInviteCode, validateInvite, submitApplication, approveApplication, rejectApplication,
  loadBannedUsersFromDb,
  login, publicUser, checkAdminPassword, remoteAdminEnabled,
  authMiddleware, extractToken
};
