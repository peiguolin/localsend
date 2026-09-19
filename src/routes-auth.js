/* 公网邀请模式 HTTP 路由：状态查询 / 加入申请 / 登录 / 登出
 * publicMode='off' 时 /api/auth/status 返回 mode:'off'，其余接口仍可用但不影响 LAN（登录仅对 invite 模式有意义）。
 * 登录成功签发会话 token（同时写 HttpOnly cookie，供 <img>/<audio> 等无法带 Authorization 头的资源使用）。 */
'use strict';
const auth = require('./auth');
const { PUBLIC_MODE } = require('./config');
const { insertAudit } = require('../db.js');

// 登录/申请接口的按 IP 频率闸（防口令爆破/刷申请；宽松阈值，仅挡暴力尝试）
const attemptHits = new Map(); // 'ip:action' -> number[]
function rateGate(ip, action, limit, windowMs) {
  const key = `${ip || '?'}:${action}`;
  const now = Date.now();
  let arr = attemptHits.get(key);
  if (!arr) { arr = []; attemptHits.set(key, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}

function registerRoutes(app) {
  // 当前认证状态：前端据此决定跳 /join.html 还是直连
  app.get('/api/auth/status', (req, res) => {
    const session = auth.extractToken(req) ? auth.validateSession(auth.extractToken(req)) : null;
    res.json({
      ok: true,
      mode: PUBLIC_MODE,
      authed: !!session,
      user: session ? { id: session.userId, username: session.username, nickname: session.nickname, role: session.role } : null
    });
  });

  // 加入申请：邀请码 + 用户名 + 密码 + 昵称 -> pending，等待管理员审批
  app.post('/api/join', require('express').json({ limit: '16kb' }), (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const ip = auth.clientIp(req);
    if (PUBLIC_MODE !== 'invite') {
      return res.status(403).json({ ok: false, error: '当前未开启邀请模式' });
    }
    if (!rateGate(ip, 'join', 10, 60000)) {
      return res.status(429).json({ ok: false, error: '申请过于频繁，请稍后再试' });
    }
    const r = auth.submitApplication({
      code: body.code, username: body.username, password: body.password, nickname: body.nickname,
      ip, ua: req.headers['user-agent'] || ''
    });
    if (!r.ok) return res.status(400).json(r);
    try {
      insertAudit({ actor: '申请', action: 'join_apply', target: String(body.username || ''), detail: `IP: ${ip}` });
    } catch (_) { /* 审计失败不阻塞 */ }
    res.json({ ok: true, id: r.id, message: '申请已提交，等待管理员审批' });
  });

  // 登录：用户名 + 密码 -> 会话 token（响应体 + HttpOnly cookie）
  app.post('/api/login', require('express').json({ limit: '16kb' }), (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const ip = auth.clientIp(req);
    if (PUBLIC_MODE !== 'invite') {
      return res.status(403).json({ ok: false, error: '当前未开启邀请模式' });
    }
    if (!rateGate(ip, 'login', 10, 60000)) {
      return res.status(429).json({ ok: false, error: '尝试过于频繁，请稍后再试' });
    }
    const r = auth.login(body.username, body.password);
    if (!r.ok) {
      // 登录失败审计（配合登录限流防爆破；操作日志可查）
      try {
        insertAudit({ actor: String(body.username || '?'), action: 'login_fail', target: String(body.username || ''), detail: `IP: ${ip}` });
      } catch (_) { /* 审计失败不阻塞 */ }
      return res.status(401).json(r);
    }
    // 会话写 HttpOnly cookie（供 <img>/<audio> 等无法带 Authorization 头的资源鉴权）；应用恒为 HTTPS，故加 Secure
    const maxAge = 30 * 24 * 60 * 60;
    res.setHeader('Set-Cookie',
      `ls_session=${encodeURIComponent(r.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`);
    res.json({ ok: true, token: r.token, user: auth.publicUser(r.user) });
  });

  // 登出：作废会话 + 清 cookie
  app.post('/api/logout', require('express').json({ limit: '4kb' }), (req, res) => {
    const token = auth.extractToken(req);
    if (token) auth.revokeSession(token);
    res.setHeader('Set-Cookie', 'ls_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    res.json({ ok: true });
  });

  // 本人改密：凭「用户名 + 旧密码」证明身份（无需登录会话），成功后吊销该账号全部会话
  // 公开路由（已在 authMiddleware 白名单）；独立按 IP 限流防爆破
  app.post('/api/password/change', require('express').json({ limit: '16kb' }), (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const ip = auth.clientIp(req);
    if (PUBLIC_MODE !== 'invite') {
      return res.status(403).json({ ok: false, error: '当前未开启邀请模式' });
    }
    if (!rateGate(ip, 'pwdchange', 5, 60000)) {
      return res.status(429).json({ ok: false, error: '操作过于频繁，请稍后再试' });
    }
    const r = auth.changePassword(body.username, body.oldPassword, body.newPassword);
    if (!r.ok) return res.status(400).json(r);
    try {
      insertAudit({ actor: String(body.username || ''), action: 'change_password', target: String(body.username || ''), detail: `IP: ${ip}` });
    } catch (_) { /* 审计失败不阻塞 */ }
    res.json({ ok: true, message: '密码已修改，请用新密码重新登录' });
  });

  // 管理员重置密码：role='admin' 的登录账号（远程）或宿主机直连可执行；被重置账号会话全部吊销
  app.post('/api/password/reset', require('express').json({ limit: '16kb' }), (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const ip = auth.clientIp(req);
    const session = auth.extractToken(req) ? auth.validateSession(auth.extractToken(req)) : null;
    const isAdminUser = !!(session && session.role === 'admin');
    if (!auth.isDirectLocalReq(req) && !isAdminUser) {
      return res.status(403).json({ ok: false, error: '仅管理员可重置密码' });
    }
    const r = auth.resetPassword(body.username, body.newPassword);
    if (!r.ok) return res.status(400).json(r);
    try {
      insertAudit({ actor: (session && session.username) || '宿主机', action: 'reset_password', target: String(body.username || ''), detail: `IP: ${ip}` });
    } catch (_) { /* 审计失败不阻塞 */ }
    res.json({ ok: true, message: `已重置「${r.username}」的密码` });
  });
}

module.exports = { registerRoutes };
