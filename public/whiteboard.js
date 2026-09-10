/* 实时白板：Canvas 多人协作涂鸦
 * 本地笔迹 → 40ms 批量广播坐标点；远程笔迹增量渲染；
 * 坐标归一化 [0,1] 适配不同窗口尺寸；服务器保存完整历史供后加入者重放。 */
(function () {
  'use strict';

  if (!window.chatApp) return; // 依赖 client.js / share.js 先加载
  const socket = window.chatApp.socket;

  // ---------- DOM ----------
  const tabBoard = document.getElementById('tabBoard');
  const boardView = document.getElementById('boardView');
  const boardWrap = document.getElementById('boardWrap');
  const canvas = document.getElementById('boardCanvas');
  const boardColors = document.getElementById('boardColors');
  const colorPicker = document.getElementById('boardColorPicker');
  const sizeRange = document.getElementById('boardSize');
  const eraserBtn = document.getElementById('boardEraser');
  const undoBtn = document.getElementById('boardUndo');
  const clearBtn = document.getElementById('boardClear');
  const ctx = canvas.getContext('2d');

  // ---------- 状态 ----------
  const PRESET_COLORS = ['#1f2328', '#dc2626', '#f59e0b', '#16a34a', '#4f6ef7', '#8b5cf6'];
  let tool = 'pen';                 // 'pen' | 'eraser'
  let color = PRESET_COLORS[4];
  let size = Number(sizeRange.value); // 逻辑粗细（1000px 宽画布下的 px）
  let strokes = [];                 // 已完成笔迹（含他人的）
  const active = new Map();         // id -> 进行中的笔迹（本地+远程）
  let cur = null;                   // 本地进行中的笔迹
  let pendingPts = [];              // 待发送的坐标点
  let lastFlush = 0;
  let joined = false;
  let idSeq = 0;
  let cssW = 0;
  let cssH = 0;

  // ---------- 注册 Tab ----------
  window.chatApp.registerTab('board', tabBoard, [boardView]);
  tabBoard.addEventListener('click', () => {
    ensureJoined();
    resizeCanvas();
  });

  // ---------- 画布尺寸（DPR 适配 + resize 重绘） ----------
  function resizeCanvas() {
    const w = boardWrap.clientWidth;
    const h = boardWrap.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    cssW = w;
    cssH = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderAll();
    repositionCursors();
  }
  new ResizeObserver(resizeCanvas).observe(boardWrap);

  // ---------- 渲染 ----------
  function lineWidth(s) {
    return Math.max(1, s.size * (cssW / 1000));
  }

  function applyStrokeStyle(s) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = lineWidth(s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  }

  function toPx(p) {
    return [p[0] * cssW, p[1] * cssH];
  }

  function drawDot(s, p) {
    const [x, y] = toPx(p);
    ctx.beginPath();
    ctx.arc(x, y, lineWidth(s) / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 增量渲染：只绘制 s.drawn 之后新增的线段
  function drawIncremental(s) {
    if (!cssW || !s.pts.length) return;
    ctx.save();
    applyStrokeStyle(s);
    if (s.pts.length === 1) {
      if (s.drawn === 0) drawDot(s, s.pts[0]);
    } else {
      const start = Math.max(0, s.drawn - 1);
      const [x0, y0] = toPx(s.pts[start]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (let i = start + 1; i < s.pts.length; i++) {
        const [x, y] = toPx(s.pts[i]);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    s.drawn = s.pts.length;
  }

  // 全量重绘（初始化/撤销/清空/resize 后）
  function renderAll() {
    if (!cssW) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.restore();
    for (const s of strokes) {
      s.drawn = 0;
      drawIncremental(s);
    }
    for (const s of active.values()) {
      s.drawn = 0;
      drawIncremental(s);
    }
  }

  // ---------- 加入与同步 ----------
  function ensureJoined() {
    if (joined) return;
    joined = true;
    socket.emit('wb_join', (res) => {
      if (res && res.ok && Array.isArray(res.strokes)) {
        strokes = res.strokes.map((s) => ({ ...s, drawn: 0 }));
        renderAll();
      }
      // 已进入白板的其他人的光标
      if (res && res.ok && Array.isArray(res.cursors)) {
        for (const c of res.cursors) upsertCursor(c);
      }
    });
  }

  socket.on('connect', () => {
    // 重连后本地状态失效，重新拉取
    joined = false;
    strokes = [];
    active.clear();
    cur = null;
    clearAllCursors();
    if (!boardView.hidden) ensureJoined();
    renderAll();
  });

  // ---------- 远程笔迹 ----------
  socket.on('wb_begin', (d) => {
    if (!d || !d.id) return;
    const s = { color: d.color, size: d.size, tool: d.tool, pts: [[d.x, d.y]], drawn: 0 };
    active.set(d.id, s);
    drawIncremental(s);
  });

  socket.on('wb_pts', (d) => {
    const s = d && active.get(d.id);
    if (!s || !Array.isArray(d.pts)) return;
    for (const p of d.pts) s.pts.push(p);
    drawIncremental(s);
  });

  socket.on('wb_end', (d) => {
    const s = d && active.get(d.id);
    if (!s) return;
    active.delete(d.id);
    strokes.push(s);
  });

  socket.on('wb_remove', (d) => {
    if (!d) return;
    strokes = strokes.filter((s) => s.id !== d.id);
    renderAll();
  });

  socket.on('wb_clear', () => {
    strokes = [];
    active.clear();
    cur = null;
    renderAll();
  });

  // ---------- 本地绘制 ----------
  function normPos(e) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4];
  }

  function flushPending(force) {
    if (!cur || !pendingPts.length) return;
    const now = Date.now();
    if (!force && now - lastFlush < 40) return;
    lastFlush = now;
    socket.emit('wb_pts', { id: cur.id, pts: pendingPts.splice(0) });
  }

  function startStroke(e) {
    if (cur || !cssW) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = normPos(e);
    if (!p) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    cur = {
      id: `${socket.id}-${Date.now().toString(36)}-${idSeq++}`,
      color, size, tool,
      pts: [p], drawn: 0
    };
    drawIncremental(cur);
    socket.emit('wb_begin', { id: cur.id, color, size, tool, x: p[0], y: p[1] });
    lastFlush = Date.now();
  }

  function moveStroke(e) {
    if (!cur) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = normPos(ev);
      if (!p) continue;
      cur.pts.push(p);
      pendingPts.push(p);
    }
    drawIncremental(cur);
    flushPending(false);
  }

  function endStroke() {
    if (!cur) return;
    flushPending(true);
    socket.emit('wb_end', {
      id: cur.id, color: cur.color, size: cur.size, tool: cur.tool, pts: cur.pts
    });
    strokes.push(cur);
    cur = null;
    pendingPts = [];
  }

  canvas.addEventListener('pointerdown', startStroke);
  canvas.addEventListener('pointermove', moveStroke);
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  // ---------- 多人实时光标 ----------
  const cursors = new Map(); // socketId -> { el, x, y }
  let lastCursorSend = 0;

  function positionCursor(c) {
    if (!cssW) return;
    c.el.style.transform = `translate(${c.x * cssW}px, ${c.y * cssH}px)`;
  }

  function repositionCursors() {
    for (const c of cursors.values()) positionCursor(c);
  }

  function upsertCursor(d) {
    if (!d || !d.id || d.id === socket.id) return;
    let c = cursors.get(d.id);
    if (!c) {
      const el = document.createElement('div');
      el.className = 'wb-cursor';
      el.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24"><path d="M4 2 L20 12 L13 13 L10 20 Z" fill="var(--cc)" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/></svg>
        <span class="wb-cursor-name"></span>`;
      el.style.setProperty('--cc', d.color || '#2563eb');
      boardWrap.appendChild(el);
      c = { el, x: 0, y: 0 };
      cursors.set(d.id, c);
    }
    // 昵称可能中途修改过，每次都刷新
    const nameEl = c.el.querySelector('.wb-cursor-name');
    if (nameEl.textContent !== (d.nickname || '')) nameEl.textContent = d.nickname || '';
    c.x = d.x;
    c.y = d.y;
    positionCursor(c);
  }

  function clearAllCursors() {
    for (const c of cursors.values()) c.el.remove();
    cursors.clear();
  }

  socket.on('wb_cursor', upsertCursor);
  socket.on('wb_cursor_leave', (d) => {
    const c = d && cursors.get(d.id);
    if (c) {
      c.el.remove();
      cursors.delete(d.id);
    }
  });

  // 本地光标上报（33ms 节流，约 30fps）
  boardWrap.addEventListener('pointermove', (e) => {
    const now = Date.now();
    if (now - lastCursorSend < 33) return;
    const p = normPos(e);
    if (!p) return;
    lastCursorSend = now;
    socket.emit('wb_cursor', { x: p[0], y: p[1] });
  });
  // 移出画布 / 切走白板 Tab → 广播光标消失
  boardWrap.addEventListener('pointerleave', () => socket.emit('wb_cursor_leave'));
  ['tabChat', 'tabShare'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => socket.emit('wb_cursor_leave'));
  });

  // ---------- 工具栏 ----------
  function refreshToolUI() {
    eraserBtn.classList.toggle('active', tool === 'eraser');
    boardColors.querySelectorAll('.board-swatch').forEach((el) => {
      el.classList.toggle('active', tool === 'pen' && el.dataset.color === color);
    });
  }

  function setColor(c) {
    color = c;
    tool = 'pen';
    colorPicker.value = c;
    refreshToolUI();
  }

  for (const c of PRESET_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'board-swatch';
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => setColor(c));
    boardColors.appendChild(b);
  }

  colorPicker.addEventListener('input', () => setColor(colorPicker.value));
  sizeRange.addEventListener('input', () => { size = Number(sizeRange.value) || 4; });
  eraserBtn.addEventListener('click', () => {
    tool = tool === 'eraser' ? 'pen' : 'eraser';
    refreshToolUI();
  });
  undoBtn.addEventListener('click', () => socket.emit('wb_undo'));
  clearBtn.addEventListener('click', () => {
    if (window.confirm('确定清空整块白板吗？所有人的画面都会同步清空。')) {
      socket.emit('wb_clear');
    }
  });

  refreshToolUI();
})();
