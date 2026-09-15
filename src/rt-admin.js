/* 用户管理（仅宿主机）：在线用户列表 + 剔除（封禁，禁重连）/ 限时禁言 / 禁机器人。
 * 状态在 src/state.js（mutes/botBans/bans，内存态，重启不持久）；
 * 强制点：连接（server.js ban 校验）、聊天（rt-chat 禁言校验）、机器人（rt-bot botBans 校验）。 */
const store = require('../db.js');
const state = require('./state');
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
  const guard = () => isLocalSocket(socket);
  const deny = (cb) => cb && cb({ ok: false, error: '仅宿主机可操作' });

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
    cb && cb({ ok: true, kicked });
  });

  // 解除封禁（允许重新加入）
  socket.on('admin_unban', (data, cb) => {
    if (!guard()) return deny(cb);
    const cid = String((data && data.clientId) || '');
    state.bans.delete(cid);
    persistUserAdmin(cid);
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
      cb && cb({ ok: true, mutedUntil: until });
    } else {
      state.mutes.delete(cid);
      cb && cb({ ok: true, mutedUntil: 0 });
    }
    persistUserAdmin(cid);
  });

  // 禁/解禁 @机器人 权限
  socket.on('admin_botban', (data, cb) => {
    if (!guard()) return deny(cb);
    const cid = String((data && data.clientId) || '');
    if (!cid) return cb && cb({ ok: false, error: '缺少 clientId' });
    if (data && data.banned) state.botBans.add(cid);
    else state.botBans.delete(cid);
    persistUserAdmin(cid);
    cb && cb({ ok: true });
  });
}

module.exports = { register, loadUserAdminFromDb };
