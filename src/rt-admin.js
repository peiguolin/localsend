/* 用户管理（宿主机；公网邀请模式下支持管理员口令远程登录）：
 * 在线用户列表 + 剔除（封禁，禁重连）/ 限时禁言 / 禁机器人；邀请码创建与列表、加入申请审批。
 * 状态在 src/state.js（mutes/botBans/bans，内存态，重启不持久）+ 持久化表；
 * 强制点：连接（server.js ban 校验）、聊天（rt-chat 禁言校验）、机器人（rt-bot botBans 校验）。 */
const store = require('../db.js');
const state = require('./state');
const auth = require('./auth');
const { isLocalSocket } = require('./util');

// 启动时从 DB 恢复剔除/禁言/禁机器人（跨重启持久）
function loadUserAdminFromDb() {
  let rows;
  try { rows = store.loadUserAdmin(); } catch (_) { return; }
  for (const r of rows || []) {
    if (r.banned) state.bans.set(r.cid, { nickname: r.banNick || '', at: r.banAt || 0 });
    if (r.muteUntil && r.muteUntil > Date.now()) state.mutes.set(r.cid, r.muteUntil);
    if (r.botBan) state.botBans.add(r.cid);
  }
}

// 把某 clientId 当前的管理状态写回 DB（DB 不可用不阻塞管理操作）
function persistUserAdmin(clientId) {
  try {
    const cid = String(clientId || '');
    if (!cid) return;
    const ban = state.bans.get(cid);
    store.setUserAdmin(cid, {
      banned: state.bans.has(cid),
      banNickname: (ban && ban.nickname) || '',
      banAt: (ban && ban.at) || 0,
      muteUntil: state.mutes.get(cid) || 0,
      botBan: state.botBans.has(cid)
    });
  } catch (_) { /* ignore */ }
}

function register(io, socket) {
  // 权限门槛：宿主机（LAN/本机），或已通过 admin_login 口令认证的远程管理员，
  // 或 role='admin' 的登录账号（管理员权限分配：宿主在「邀请与审批」里授予）
  const isAdmin = () => isLocalSocket(socket) || socket.data.isRemoteAdmin === true || socket.data.role === 'admin';
  const guard = () => {
    if (isAdmin()) return true;
    return false;
  };
  const deny = (cb) => cb && cb({ ok: false, error: '仅管理员可操作' });

  // 远程管理员口令登录（invite 模式下从公网管理；口令校验失败计数，超限断开防爆破）
  let loginFails = 0;
  socket.on('admin_login', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    if (isLocalSocket(socket)) { cb && cb({ ok: true, local: true }); return; }
    if (!auth.remoteAdminEnabled()) return cb && cb({ ok: false, error: '未配置管理员口令，仅宿主机可管理' });
    const pw = String((data && data.password) || '');
    if (auth.checkAdminPassword(pw)) {
      socket.data.isRemoteAdmin = true;
      loginFails = 0;
      try {
        store.insertAudit({ actor: '远程管理员', action: 'admin_login', target: '', detail: `IP: ${auth.socketIp(socket)}` });
      } catch (_) { /* ignore */ }
      cb && cb({ ok: true, remote: true });
    } else {
      loginFails++;
      if (loginFails >= 5) {
        try {
          store.insertAudit({ actor: '?', action: 'admin_login_fail', target: '', detail: `IP: ${auth.socketIp(socket)} 连续失败，已断开` });
        } catch (_) { /* ignore */ }
        socket.disconnect(true);
        return;
      }
      cb && cb({ ok: false, error: '口令错误' });
    }
  });

  // 写一条审计日志（target 尽量解析为昵称，失败退回 clientId）
  function audit(action, targetCid, detail) {
    let targetName = '';
    for (const [, s] of io.sockets.sockets) {
      if (String(s.data.clientId || '') === targetCid) { targetName = s.data.nickname || ''; break; }
    }
    if (!targetName) {
      const ban = state.bans.get(targetCid);
      if (ban) targetName = ban.nickname || '';
    }
    try {
      store.insertAudit({
        actor: socket.data.nickname || '宿主机',
        action,
        target: targetName || String(targetCid || ''),
        detail: detail || ''
      });
    } catch (_) { /* DB 不可用不阻塞管理操作 */ }
  }

  // 当前在线用户（含其禁言/禁机器人/封禁状态）
  function listUsers() {
    const out = [];
    for (const [id, s] of io.sockets.sockets) {
      const cid = String(s.data.clientId || '');
      const until = state.mutes.get(cid) || 0;
      out.push({
        id, nickname: s.data.nickname || '', clientId: cid,
        isLocal: isLocalSocket(s),
        mutedUntil: until > Date.now() ? until : 0,
        botBanned: state.botBans.has(cid),
        banned: state.bans.has(cid)
      });
    }
    return out;
  }

  socket.on('admin_users', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; } // 兼容 emit(event, cb) 与 emit(event, data, cb)
    if (!guard()) return deny(cb);
    const banned = Array.from(state.bans.entries()).map(([cid, b]) => ({
      clientId: cid, nickname: (b && b.nickname) || '', at: (b && b.at) || 0
    }));
    cb && cb({ ok: true, users: listUsers(), banned });
  });

  // 剔除：封禁该 clientId（禁止重连）并断开其当前连接（不允许剔除自己）
  socket.on('admin_kick', (data, cb) => {
    if (!guard()) return deny(cb);
    const cid = String((data && data.clientId) || '');
    if (!cid) return cb && cb({ ok: false, error: '缺少 clientId' });
    if (cid === String(socket.data.clientId || '')) return cb && cb({ ok: false, error: '不能剔除自己' });
    let kicked = 0; let nickname = '';
    for (const [, s] of io.sockets.sockets) {
      if (String(s.data.clientId || '') === cid) {
        nickname = nickname || s.data.nickname || '';
        s.emit('system_message', { text: '你已被移出聊天室，无法重新加入' });
        s.disconnect(true);
        kicked++;
      }
    }
    state.bans.set(cid, { nickname, at: Date.now() });
    persistUserAdmin(cid);
    if (auth.inviteEnabled()) { try { store.setUserBanned(cid, true); } catch (_) { /* ignore */ } }
    auth.revokeUserSessions(cid); // 账号封禁：吊销其全部会话（HTTP 与后续握手一并失效）
    audit('kick', cid, `剔除并封禁（断开 ${kicked} 个连接）`);
    cb && cb({ ok: true, kicked });
  });

  // 解除封禁（允许重新加入）
  socket.on('admin_unban', (data, cb) => {
    if (!guard()) return deny(cb);
    const cid = String((data && data.clientId) || '');
    state.bans.delete(cid);
    persistUserAdmin(cid);
    if (auth.inviteEnabled()) { try { store.setUserBanned(cid, false); } catch (_) { /* ignore */ } }
    audit('unban', cid, '解除封禁');
    cb && cb({ ok: true });
  });

  // 限时禁言：minutes>0 禁言 minutes 分钟；<=0 解禁
  socket.on('admin_mute', (data, cb) => {
    if (!guard()) return deny(cb);
    const cid = String((data && data.clientId) || '');
    if (!cid) return cb && cb({ ok: false, error: '缺少 clientId' });
    const minutes = Number((data && data.minutes) || 0);
    if (minutes > 0) {
      const until = Date.now() + minutes * 60000;
      state.mutes.set(cid, until);
      audit('mute', cid, `禁言 ${minutes} 分钟`);
      cb && cb({ ok: true, mutedUntil: until });
    } else {
      state.mutes.delete(cid);
      audit('unmute', cid, '解除禁言');
      cb && cb({ ok: true, mutedUntil: 0 });
    }
    persistUserAdmin(cid);
  });

  // 禁/解禁 @机器人 权限
  socket.on('admin_botban', (data, cb) => {
    if (!guard()) return deny(cb);
    const cid = String((data && data.clientId) || '');
    if (!cid) return cb && cb({ ok: false, error: '缺少 clientId' });
    if (data && data.banned) { state.botBans.add(cid); audit('botban', cid, '禁止 @机器人'); }
    else { state.botBans.delete(cid); audit('unbotban', cid, '恢复 @机器人'); }
    persistUserAdmin(cid);
    cb && cb({ ok: true });
  });

  // 查最近审计日志（仅宿主机）
  socket.on('admin_audit', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    if (!guard()) return deny(cb);
    let rows = [];
    try { rows = store.listAudit((data && data.limit) || 50); } catch (_) { rows = []; }
    cb && cb({ ok: true, entries: rows });
  });

  // ---------- 公网邀请模式：邀请码管理 + 加入申请审批 ----------

  // 邀请码：list | create | delete
  socket.on('admin_invites', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    if (!guard()) return deny(cb);
    const action = String((data && data.action) || 'list');
    if (action === 'create') {
      const maxUses = Math.min(Math.max(Number((data && data.maxUses) || 1), 1), 100);
      const expiresDays = Math.max(Number((data && data.expiresDays) || 0), 0);
      const code = auth.genInviteCode();
      try {
        store.insertInvite({
          code,
          note: String((data && data.note) || '').slice(0, 100),
          createdBy: socket.data.nickname || '管理员',
          createdAt: Date.now(),
          expiresAt: expiresDays > 0 ? Date.now() + expiresDays * 24 * 3600 * 1000 : 0,
          usedCount: 0, maxUses
        });
        audit('invite_create', '', `生成邀请码 ${code}（可用 ${maxUses} 次${expiresDays > 0 ? `，${expiresDays} 天有效` : ''}）`);
        cb && cb({ ok: true, code });
      } catch (e) {
        cb && cb({ ok: false, error: `创建失败：${e.message}` });
      }
      return;
    }
    if (action === 'delete') {
      const code = String((data && data.code) || '');
      try {
        store.deleteInvite(code);
        audit('invite_delete', '', `删除邀请码 ${code}`);
        cb && cb({ ok: true });
      } catch (e) {
        cb && cb({ ok: false, error: `删除失败：${e.message}` });
      }
      return;
    }
    let rows = [];
    try {
      rows = store.listInvites().map((inv) => ({
        ...inv,
        applied: store.applicationCountByInvite(inv.code)
      }));
    } catch (_) { rows = []; }
    cb && cb({ ok: true, invites: rows });
  });

  // 加入申请列表（含 IP / UA / 邀请码，供管理员审批判断）
  socket.on('admin_applications', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    if (!guard()) return deny(cb);
    let rows = [];
    try { rows = store.listPendingApplications(); } catch (_) { rows = []; }
    cb && cb({ ok: true, applications: rows });
  });

  // 审批通过：申请 -> 账号（用户可用申请的账号密码登录）
  socket.on('admin_approve', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    if (!guard()) return deny(cb);
    const id = Number((data && data.id) || 0);
    const r = auth.approveApplication(id, socket.data.nickname || '管理员');
    if (!r.ok) return cb && cb(r);
    audit('join_approve', r.userId || '', `通过申请 #${id}（${r.username || ''}）`);
    cb && cb({ ok: true, userId: r.userId, username: r.username });
  });

  // 审批拒绝
  socket.on('admin_reject', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    if (!guard()) return deny(cb);
    const id = Number((data && data.id) || 0);
    const reason = String((data && data.reason) || '');
    const r = auth.rejectApplication(id, socket.data.nickname || '管理员', reason);
    if (!r.ok) return cb && cb(r);
    audit('join_reject', '', `拒绝申请 #${id}${reason ? `（原因：${reason}）` : ''}`);
    cb && cb({ ok: true });
  });

  // 账号列表（管理员权限分配用；含角色与封禁状态）
  socket.on('admin_accounts', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    if (!guard()) return deny(cb);
    let rows = [];
    try { rows = store.listUsers(); } catch (_) { rows = []; }
    cb && cb({ ok: true, users: rows });
  });

  // 管理员权限分配/回收：把 role 授予/收回某个登录账号（invite 模式）
  // 授予后该账号重新登录即获得管理员身份（socket 管理 + HTTP 配置读写）；
  // 回收时吊销其全部会话，旧会话立即失效。
  socket.on('admin_set_role', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    if (!guard()) return deny(cb);
    const username = String((data && data.username) || '').trim();
    const role = String((data && data.role) || '') === 'admin' ? 'admin' : 'user';
    if (!username) return cb && cb({ ok: false, error: '缺少用户名' });
    const u = store.getUserByUsername(username);
    if (!u) return cb && cb({ ok: false, error: '账号不存在' });
    // 自己不能回收自己（防止唯一管理员意外锁死；宿主仍可用 admin_login/本机兜底）
    if (role !== 'admin' && socket.data.role === 'admin' && String(u.id) === String(socket.data.clientId || '')) {
      return cb && cb({ ok: false, error: '不能回收自己的管理员权限' });
    }
    const ok = store.setUserRole(username, role);
    if (role !== 'admin') auth.revokeUserSessions(u.id); // 降权：旧会话立即失效
    audit(role === 'admin' ? 'grant_admin' : 'revoke_admin', u.id, `账号 ${username} → ${role}`);
    cb && cb({ ok, username, role });
  });
}

module.exports = { register, loadUserAdminFromDb };
