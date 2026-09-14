/* 实时白板：笔迹中继/历史/撤销/清空 + 多人实时光标 */
const store = require('../db.js');
const state = require('./state');
const {
  WB_MAX_STROKES, WB_MAX_POINTS_PER_STROKE, WB_MAX_TOTAL_POINTS, WB_COLOR_RE, CURSOR_PALETTE
} = require('./config');

const { wbStrokes, cursorColors, wbCursors, onlineUsers } = state;

let io = null;

function wbClamp01(v) {
  v = Number(v);
  if (!Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

function wbCleanPoints(ptsRaw, maxCount) {
  const pts = [];
  for (const p of ptsRaw) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const x = wbClamp01(p[0]);
    const y = wbClamp01(p[1]);
    if (x === null || y === null) continue;
    pts.push([Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
    if (pts.length >= maxCount) break;
  }
  return pts;
}

// 校验并净化一条完整笔迹；非法返回 null
function wbSanitizeStroke(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tool = raw.tool === 'eraser' ? 'eraser' : 'pen';
  const color = WB_COLOR_RE.test(raw.color) ? raw.color : '#1f2328';
  let size = Number(raw.size);
  if (!Number.isFinite(size)) size = 4;
  size = Math.min(40, Math.max(1, size));
  const pts = wbCleanPoints(raw.pts, WB_MAX_POINTS_PER_STROKE);
  if (!pts.length) return null;
  return { color, size, tool, pts };
}

function wbTrimHistory() {
  while (wbStrokes.length && (wbStrokes.length > WB_MAX_STROKES || state.wbTotalPoints > WB_MAX_TOTAL_POINTS)) {
    state.wbTotalPoints -= wbStrokes.shift().pts.length;
  }
}

// 分配当前使用人数最少的颜色，尽量避免撞色
function assignCursorColor() {
  const counts = new Map(CURSOR_PALETTE.map((c) => [c, 0]));
  for (const c of cursorColors.values()) counts.set(c, (counts.get(c) || 0) + 1);
  let best = CURSOR_PALETTE[0];
  for (const [c, n] of counts) {
    if (n < counts.get(best)) best = c;
  }
  return best;
}

function register(ioRef, socket) {
  io = ioRef;

  // 起笔：校验样式与首点后广播给其他人
  socket.on('wb_begin', (data) => {
    const id = String((data && data.id) || '').slice(0, 40);
    if (!id) return;
    const s = wbSanitizeStroke({ ...(data || {}), pts: [[data && data.x, data && data.y]] });
    if (!s) return;
    socket.broadcast.emit('wb_begin', {
      id, author: socket.data.nickname, color: s.color, size: s.size, tool: s.tool,
      x: s.pts[0][0], y: s.pts[0][1]
    });
  });

  // 笔迹点批量中继（不落历史，仅转发）
  socket.on('wb_pts', (data) => {
    const id = String((data && data.id) || '').slice(0, 40);
    if (!id) return;
    const pts = wbCleanPoints((data && data.pts) || [], 300);
    if (!pts.length) return;
    socket.broadcast.emit('wb_pts', { id, pts });
  });

  // 收笔：完整笔迹存历史（authorId 用于撤销），其他人收尾该活动笔迹
  socket.on('wb_end', (data) => {
    const id = String((data && data.id) || '').slice(0, 40);
    if (!id) return;
    const s = wbSanitizeStroke(data);
    if (!s) return;
    const stroke = { id, authorId: socket.id, author: socket.data.nickname, ...s };
    wbStrokes.push(stroke);
    state.wbTotalPoints += s.pts.length;
    wbTrimHistory();
    store.insertStroke(stroke);
    socket.broadcast.emit('wb_end', { id, author: socket.data.nickname });
  });

  // 后加入者拉取全量笔迹与在线光标
  socket.on('wb_join', (cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    // 幂等恢复：把数据库笔迹合并进内存（按 id 去重，补上 authorId 用于撤销）
    if (wbStrokes.length === 0) {
      const saved = store.loadStrokes('main');
      for (const s of saved) {
        wbStrokes.push({ ...s, authorId: null }); // authorId 服务重启后无法还原，撤销仅对本次会话有效
        state.wbTotalPoints += s.pts.length;
      }
    }
    cb({
      ok: true,
      strokes: wbStrokes.map((s) => ({
        id: s.id, author: s.author, color: s.color, size: s.size, tool: s.tool, pts: s.pts
      })),
      cursors: Array.from(wbCursors.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, p]) => ({
          id,
          nickname: onlineUsers.get(id) || '',
          color: cursorColors.get(id) || '#2563eb',
          x: p.x, y: p.y
        }))
    });
  });

  // 光标位置中继（15ms 限频防刷，广播给其他人）
  socket.on('wb_cursor', (data) => {
    const x = wbClamp01(data && data.x);
    const y = wbClamp01(data && data.y);
    if (x === null || y === null) return;
    const now = Date.now();
    if (now - socket.data.lastCursorRelay < 15) return;
    socket.data.lastCursorRelay = now;
    wbCursors.set(socket.id, { x, y });
    socket.broadcast.emit('wb_cursor', {
      id: socket.id, nickname: socket.data.nickname, color: cursorColors.get(socket.id), x, y
    });
  });

  // 主动离开白板/移出画布 → 摘除光标
  socket.on('wb_cursor_leave', () => {
    if (wbCursors.delete(socket.id)) {
      socket.broadcast.emit('wb_cursor_leave', { id: socket.id });
    }
  });

  // 撤销自己的最后一笔
  socket.on('wb_undo', () => {
    for (let i = wbStrokes.length - 1; i >= 0; i--) {
      if (wbStrokes[i].authorId === socket.id) {
        const [removed] = wbStrokes.splice(i, 1);
        state.wbTotalPoints -= removed.pts.length;
        store.removeStrokeByAuthor(socket.id);
        io.emit('wb_remove', { id: removed.id, author: socket.data.nickname });
        return;
      }
    }
  });

  // 清空画布（所有人同步）
  socket.on('wb_clear', () => {
    wbStrokes.length = 0;
    state.wbTotalPoints = 0;
    store.clearStrokes('main');
    io.emit('wb_clear', { author: socket.data.nickname });
  });
}

// 断线清理：摘除光标颜色与位置，并通知他人移除
function onDisconnect(ioRef, socket) {
  io = ioRef;
  cursorColors.delete(socket.id);
  if (wbCursors.delete(socket.id)) {
    io.emit('wb_cursor_leave', { id: socket.id });
  }
}

module.exports = { register, onDisconnect, assignCursorColor };
