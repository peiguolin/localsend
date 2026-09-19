/* 文件夹共享（File System Access API + 服务器中转）：注册表、令牌、HTTP 中转路由、Socket 事件 */
const crypto = require('crypto');
const state = require('./state');
const { contentDisposition } = require('./util');
const { TRANSFER_START_TIMEOUT, OWNER_ACK_TIMEOUT, WRITE_ACK_TIMEOUT } = require('./config');

const { shares, shareTokens, pendingTransfers } = state;

// 模块级 io 引用（register/registerRoutes 时注入，供 broadcastShares 等模块内函数使用）
let io = null;

function hashPassword(pw, salt) {
  return crypto.createHash('sha256').update(`${salt}:${pw}`).digest('hex');
}

function issueToken(shareId, socketId, isOwner) {
  const token = crypto.randomBytes(24).toString('hex');
  shareTokens.set(token, { shareId, socketId, isOwner: !!isOwner });
  return token;
}

function revokeGuestTokens(shareId) {
  for (const [token, t] of shareTokens) {
    if (t.shareId === shareId && !t.isOwner) shareTokens.delete(token);
  }
}

function publicShareInfo(share) {
  return {
    id: share.id,
    name: share.name,
    owner: share.ownerNick,
    locked: !!share.passwordHash,
    writable: share.writable,
    createdAt: share.createdAt
  };
}

function broadcastShares() {
  io.emit('shares_update', Array.from(shares.values()).map(publicShareInfo));
}

function myShareOf(socketId) {
  for (const share of shares.values()) {
    if (share.ownerId === socketId) return share;
  }
  return null;
}

// 共享路径净化：防路径穿越/非法字符，返回相对路径串；非法返回 null
function sanitizeSharePath(raw) {
  const p = String(raw == null ? '' : raw);
  if (p.length > 512) return null;
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null;
    // eslint-disable-next-line no-control-regex
    if (/[\\<>:"|?*\x00-\x1f]/.test(seg)) return null;
    out.push(seg);
    if (out.length > 20) return null;
  }
  return out.join('/');
}

// 校验 :id 共享存在且 token 有权限访问
function authShare(req) {
  const share = shares.get(String(req.params.id || ''));
  if (!share) return { status: 404, error: '共享不存在或已关闭' };
  const t = shareTokens.get(String(req.query.token || ''));
  if (!t || t.shareId !== share.id) {
    return { status: 401, error: '未授权，请先进入共享', needAuth: true };
  }
  return { share, tokenInfo: t };
}

// 校验 push/pull 来自共享者本人
function authOwner(req, share) {
  const t = shareTokens.get(String(req.query.token || ''));
  return t && t.shareId === share.id && t.isOwner;
}

function failTransfer(transferId, statusCode, message) {
  const t = pendingTransfers.get(transferId);
  if (!t) return;
  clearTimeout(t.timer);
  pendingTransfers.delete(transferId);
  const target = t.res;
  if (target && !target.headersSent) {
    target.status(statusCode).json({ ok: false, error: message });
  } else if (target) {
    target.destroy();
  }
  if (t.req && !t.req.readableEnded) t.req.destroy();
}

function removeShare(shareId) {
  if (!shares.has(shareId)) return;
  shares.delete(shareId);
  for (const [token, t] of shareTokens) {
    if (t.shareId === shareId) shareTokens.delete(token);
  }
  for (const [tid, t] of pendingTransfers) {
    if (t.shareId === shareId) failTransfer(tid, 410, '共享已关闭');
  }
  broadcastShares();
}

// ---------- HTTP 中转路由 ----------
function registerRoutes(app, ioRef) {
  io = ioRef;

  // 浏览共享目录
  app.get('/api/share/:id/list', async (req, res) => {
    const a = authShare(req);
    if (a.error) return res.status(a.status).json({ ok: false, error: a.error, needAuth: !!a.needAuth });
    const p = sanitizeSharePath(req.query.path);
    if (p === null) return res.status(400).json({ ok: false, error: '路径无效' });
    const owner = io.sockets.sockets.get(a.share.ownerId);
    if (!owner) return res.status(502).json({ ok: false, error: '共享者已离线' });
    try {
      const r = await owner.timeout(OWNER_ACK_TIMEOUT).emitWithAck('share_fs', { op: 'list', path: p });
      if (!r || !r.ok) return res.status(502).json({ ok: false, error: (r && r.error) || '共享者无响应' });
      res.json({ ok: true, path: p, entries: r.entries || [] });
    } catch (_) {
      res.status(504).json({ ok: false, error: '共享者响应超时' });
    }
  });

  // 下载共享文件（共享者浏览器 → 服务器 → 下载者）
  // 支持 Range 分段（断点续传/分段下载）：Range 头传给共享者，共享者切片推送，
  // 服务器按切片返回 206 + Content-Range；无 Range 时整文件 200，均带 Accept-Ranges: bytes
  app.get('/api/share/:id/file', (req, res) => {
    const a = authShare(req);
    if (a.error) return res.status(a.status).json({ ok: false, error: a.error, needAuth: !!a.needAuth });
    const p = sanitizeSharePath(req.query.path);
    if (p === null || !p) return res.status(400).json({ ok: false, error: '路径无效' });
    const owner = io.sockets.sockets.get(a.share.ownerId);
    if (!owner) return res.status(502).json({ ok: false, error: '共享者已离线' });

    // 解析 Range 头（bytes=start-end / bytes=start- / bytes=-suffix；end 由共享者按文件大小裁剪）
    let range = null;
    const rh = req.headers.range;
    if (typeof rh === 'string' && rh.startsWith('bytes=')) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rh);
      if (m && (m[1] !== '' || m[2] !== '')) {
        const s = m[1] === '' ? null : Number(m[1]);
        const e = m[2] === '' ? null : Number(m[2]);
        if ((s === null || Number.isInteger(s)) && (e === null || Number.isInteger(e)) &&
            !(s !== null && e !== null && e < s)) {
          range = { start: s, end: e };
        }
      }
    }

    const transferId = crypto.randomBytes(16).toString('hex');
    const t = {
      kind: 'push', shareId: a.share.id, res, started: false, range,
      timer: setTimeout(() => failTransfer(transferId, 504, '共享者传输超时'), TRANSFER_START_TIMEOUT)
    };
    pendingTransfers.set(transferId, t);
    // 下载者中途断开且共享者尚未开始推流 → 直接清理
    res.on('close', () => {
      if (!t.started && pendingTransfers.get(transferId) === t) {
        clearTimeout(t.timer);
        pendingTransfers.delete(transferId);
      }
    });

    owner.timeout(OWNER_ACK_TIMEOUT).emit('share_fs', { op: 'read', path: p, transferId, ...(range ? { range } : {}) }, (err, r) => {
      if (err || !r || !r.ok) {
        // 共享者报告超出范围（start >= 文件大小）→ 416 + 可恢复大小
        if (r && r.rangeError && !res.headersSent) {
          clearTimeout(t.timer);
          pendingTransfers.delete(transferId);
          res.status(416);
          res.setHeader('Content-Range', `bytes */${Number(r.size) || 0}`);
          res.end();
          return;
        }
        failTransfer(transferId, 404, (r && r.error) || '共享者读取文件失败');
      }
      // 读取成功则等待共享者 POST /push 推流（元信息随 push query 到达）
    });
  });

  // 共享者推流（下载数据）
  app.post('/api/share/:id/push', (req, res) => {
    const share = shares.get(String(req.params.id || ''));
    if (!share) return res.status(404).json({ ok: false, error: '共享不存在' });
    if (!authOwner(req, share)) return res.status(401).json({ ok: false, error: '无权推流' });
    const transferId = String(req.query.transferId || '');
    const t = pendingTransfers.get(transferId);
    if (!t || t.kind !== 'push' || t.shareId !== share.id) {
      return res.status(409).json({ ok: false, error: '传输不存在或已过期' });
    }
    clearTimeout(t.timer);
    pendingTransfers.delete(transferId);
    t.started = true;

    const dlRes = t.res;
    if (dlRes.destroyed || dlRes.writableEnded) {
      req.destroy();
      return res.status(410).json({ ok: false, error: '下载方已断开' });
    }
    const name = String(req.query.name || 'file').slice(0, 255);
    const size = Number(req.query.size);
    dlRes.setHeader('Accept-Ranges', 'bytes');
    dlRes.setHeader('Content-Type', 'application/octet-stream');
    dlRes.setHeader('Content-Disposition', contentDisposition(name));
    if (Number.isFinite(size) && size >= 0) dlRes.setHeader('Content-Length', size);
    dlRes.setHeader('X-Content-Type-Options', 'nosniff');
    // 分段下载：共享者带 start/total（来自 Range 请求）→ 206 + Content-Range；整文件 → 200
    const start = req.query.start !== undefined ? Number(req.query.start) : null;
    const total = req.query.total !== undefined ? Number(req.query.total) : null;
    if (start !== null && Number.isFinite(start) && start >= 0 && Number.isFinite(total) && total > 0) {
      dlRes.statusCode = 206;
      dlRes.setHeader('Content-Range', `bytes ${start}-${start + size - 1}/${total}`);
    }
    dlRes.on('close', () => { if (!dlRes.writableEnded) req.destroy(); });
    req.on('error', () => dlRes.destroy());
    req.pipe(dlRes);
    req.on('end', () => res.json({ ok: true }));
  });

  // 上传文件到共享目录（上传者 → 服务器 → 共享者浏览器写入磁盘）
  app.post('/api/share/:id/write', (req, res) => {
    const a = authShare(req);
    if (a.error) return res.status(a.status).json({ ok: false, error: a.error, needAuth: !!a.needAuth });
    if (!a.share.writable) return res.status(403).json({ ok: false, error: '该共享为只读，不允许写入' });
    const p = sanitizeSharePath(req.query.path);
    if (p === null || !p) return res.status(400).json({ ok: false, error: '路径无效' });
    const owner = io.sockets.sockets.get(a.share.ownerId);
    if (!owner) return res.status(502).json({ ok: false, error: '共享者已离线' });

    const transferId = crypto.randomBytes(16).toString('hex');
    const t = {
      kind: 'pull', shareId: a.share.id, req, res, started: false,
      timer: setTimeout(() => failTransfer(transferId, 504, '共享者传输超时'), TRANSFER_START_TIMEOUT)
    };
    pendingTransfers.set(transferId, t);
    req.on('aborted', () => {
      if (pendingTransfers.get(transferId) === t) failTransfer(transferId, 499, '上传方已断开');
    });

    const size = Number(req.headers['content-length']);
    owner.timeout(WRITE_ACK_TIMEOUT).emit('share_fs', {
      op: 'write', path: p, transferId, size: Number.isFinite(size) ? size : null
    }, (err, r) => {
      const tt = pendingTransfers.get(transferId);
      if (tt) {
        clearTimeout(tt.timer);
        pendingTransfers.delete(transferId);
      }
      if (err || !r || !r.ok) {
        if (!res.headersSent) res.status(502).json({ ok: false, error: (r && r.error) || '共享者写入失败' });
      } else if (!res.headersSent) {
        res.json({ ok: true, savedAs: r.savedAs });
      }
    });
  });

  // 共享者拉流（上传数据）
  app.get('/api/share/:id/pull', (req, res) => {
    const share = shares.get(String(req.params.id || ''));
    if (!share) return res.status(404).json({ ok: false, error: '共享不存在' });
    if (!authOwner(req, share)) return res.status(401).json({ ok: false, error: '无权拉流' });
    const transferId = String(req.query.transferId || '');
    const t = pendingTransfers.get(transferId);
    if (!t || t.kind !== 'pull' || t.shareId !== share.id) {
      return res.status(409).json({ ok: false, error: '传输不存在或已过期' });
    }
    clearTimeout(t.timer);
    t.started = true;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.on('close', () => { if (!t.req.readableEnded) t.req.destroy(); });
    t.req.on('error', () => res.destroy());
    t.req.pipe(res);
  });
}

// ---------- Socket 事件 ----------
function register(ioRef, socket) {
  io = ioRef;

  // 注册共享（每人同时只能共享一个文件夹）
  socket.on('share_register', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    // 公网邀请模式禁用：文件夹共享会把共享者本地目录暴露给所有登录用户，公网风险不可控
    if (require('./auth').inviteEnabled()) {
      return cb({ ok: false, error: '公网邀请模式下已禁用文件夹共享' });
    }
    if (myShareOf(socket.id)) return cb({ ok: false, error: '你已有共享中的文件夹，请先取消' });
    const name = (String((data && data.name) || '').trim() || '未命名共享').slice(0, 50);
    const password = data && typeof data.password === 'string' && data.password ? data.password : null;
    const id = crypto.randomBytes(8).toString('hex');
    const salt = crypto.randomBytes(8).toString('hex');
    const canWrite = !!(data && data.writable);
    shares.set(id, {
      id, name, ownerId: socket.id, ownerNick: socket.data.nickname,
      salt, passwordHash: password ? hashPassword(password, salt) : null,
      canWrite, writable: canWrite, createdAt: Date.now()
    });
    broadcastShares();
    io.emit('system_message', {
      type: 'share', nickname: socket.data.nickname,
      text: `${socket.data.nickname} 共享了文件夹「${name}」`,
      timestamp: Date.now()
    });
    cb({ ok: true, shareId: id, token: issueToken(id, socket.id, true) });
  });

  // 修改共享（名称/密码/可写）。password: undefined 不变；null 取消密码；字符串 重设密码
  socket.on('share_update', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const share = shares.get(String((data && data.shareId) || ''));
    if (!share || share.ownerId !== socket.id) return cb({ ok: false, error: '无权修改该共享' });
    if (typeof data.name === 'string' && data.name.trim()) {
      share.name = data.name.trim().slice(0, 50);
    }
    if (data.password === null) {
      share.passwordHash = null;
      revokeGuestTokens(share.id);
    } else if (typeof data.password === 'string' && data.password) {
      share.salt = crypto.randomBytes(8).toString('hex');
      share.passwordHash = hashPassword(data.password, share.salt);
      revokeGuestTokens(share.id);
    }
    if (typeof data.writable === 'boolean') {
      share.writable = data.writable && share.canWrite;
    }
    broadcastShares();
    cb({ ok: true, share: publicShareInfo(share) });
  });

  // 取消共享
  socket.on('share_unregister', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const share = shares.get(String((data && data.shareId) || ''));
    if (!share || share.ownerId !== socket.id) return cb({ ok: false, error: '无权操作该共享' });
    removeShare(share.id);
    io.emit('system_message', {
      type: 'share', nickname: socket.data.nickname,
      text: `${socket.data.nickname} 关闭了共享「${share.name}」`,
      timestamp: Date.now()
    });
    cb({ ok: true });
  });

  // 进入共享（校验密码，签发访问 token）
  socket.on('share_enter', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const share = shares.get(String((data && data.shareId) || ''));
    if (!share) return cb({ ok: false, error: '共享不存在或已关闭' });
    if (share.ownerId === socket.id || !share.passwordHash) {
      return cb({
        ok: true,
        token: issueToken(share.id, socket.id, share.ownerId === socket.id),
        share: publicShareInfo(share)
      });
    }
    const pw = String((data && data.password) || '');
    if (!pw) return cb({ ok: false, needPassword: true, error: '该共享需要密码' });
    const h = Buffer.from(hashPassword(pw, share.salt), 'utf8');
    const ref = Buffer.from(share.passwordHash, 'utf8');
    if (h.length !== ref.length || !crypto.timingSafeEqual(h, ref)) {
      return cb({ ok: false, needPassword: true, error: '密码错误' });
    }
    cb({ ok: true, token: issueToken(share.id, socket.id, false), share: publicShareInfo(share) });
  });
}

// 断线清理：移除该连接的所有 token 并关闭其共享（系统消息由调用方输出）
function onDisconnect(ioRef, socket) {
  io = ioRef;
  for (const [token, t] of shareTokens) {
    if (t.socketId === socket.id) shareTokens.delete(token);
  }
  const share = myShareOf(socket.id);
  if (share) {
    removeShare(share.id);
    io.emit('system_message', {
      type: 'share', nickname: socket.data.nickname,
      text: `${socket.data.nickname} 的共享「${share.name}」已离线`,
      timestamp: Date.now()
    });
  }
}

module.exports = {
  registerRoutes, register, onDisconnect,
  publicShareInfo, broadcastShares, myShareOf
};
