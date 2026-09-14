/* 日历：法定节假日数据接口 + 共享日程 Socket 事件（房间隔离/创建者与宿主机可删/变更广播） */
const fs = require('fs');
const path = require('path');
const store = require('../db.js');
const state = require('./state');
const { isLocalSocket } = require('./util');
const { REMIND_TICK_MS, REMIND_LATE_MS } = require('./config');

const { groupRooms, onlineUsers } = state;

// ---------- 节假日数据（holidays.json 驱动；未收录年份降级 official:false） ----------
let HOLIDAYS = { years: {} };
try {
  HOLIDAYS = JSON.parse(fs.readFileSync(path.join(__dirname, 'holidays.json'), 'utf8'));
} catch (e) {
  console.warn('  日历: 节假日数据加载失败 —', e.message);
}

// 把某一年的区间放假表展开为每日条目 { name, type:'holiday'|'workday', index, total }
function expandYear(yearNum) {
  const y = HOLIDAYS.years && HOLIDAYS.years[String(yearNum)];
  if (!y || !y.official) return { official: false, days: {} };
  const days = {};
  for (const r of y.ranges || []) {
    const from = new Date(r.from + 'T00:00:00');
    const to = new Date(r.to + 'T00:00:00');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) continue;
    const total = Math.round((to - from) / 86400000) + 1;
    for (let t = from.getTime(), i = 1; t <= to.getTime(); t += 86400000, i++) {
      const d = new Date(t);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days[ds] = { name: r.name, type: 'holiday', index: i, total };
    }
  }
  for (const wd of y.workdays || []) {
    days[wd] = { name: '调休上班', type: 'workday' };
  }
  return { official: true, days };
}

function registerRoutes(app) {
  // 某年的节假日展开表
  app.get('/api/calendar/year', (req, res) => {
    const year = Number(req.query.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      return res.status(400).json({ ok: false, error: '年份无效' });
    }
    const r = expandYear(year);
    res.json({ ok: true, year, official: r.official, days: r.days });
  });
}

// ---------- 共享日程 ----------

// 房间权限（与 rt-rooms.canSendToRoom 同规则，本地复制避免环依赖）
function canAccessRoom(roomId, clientId) {
  if (roomId === 'main') return true;
  const gr = groupRooms.get(roomId);
  return !!gr && !!clientId && gr.members.some((m) => m.clientId === clientId);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  return !Number.isNaN(d.getTime()) &&
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === s;
}

// ---------- 到点提醒 ----------
const REMIND_LABELS = { 10: '10 分钟', 30: '30 分钟', 60: '1 小时', 1440: '1 天' };

// 计算提醒触发时间（本地时区；无时间或非法则 null）
function eventFireAt(ev) {
  if (!ev.time || !TIME_RE.test(ev.time)) return null;
  const t = new Date(`${ev.date}T${ev.time}:00`);
  if (Number.isNaN(t.getTime())) return null;
  return t.getTime() - (Number(ev.remindMinutes) || 0) * 60000;
}

function checkReminders(io, now = Date.now()) {
  let candidates = [];
  try { candidates = store.listUnfiredReminders(); } catch (_) { return; }
  for (const ev of candidates) {
    const fireAt = eventFireAt(ev);
    if (fireAt === null || fireAt > now) continue;
    // 先标记再决定是否广播，保证只触发一次
    try { store.markEventReminded(ev.id, now); } catch (_) { continue; }
    // 触发时间已过去很久（如服务重启堆积）→ 静默标记，不刷屏
    if (now - fireAt > REMIND_LATE_MS) continue;
    const label = REMIND_LABELS[ev.remindMinutes] || `${ev.remindMinutes} 分钟`;
    io.to(ev.room).emit('system_message', {
      type: 'calendar', room: ev.room, nickname: '日历',
      text: `📅 日程提醒：「${ev.title}」将于 ${ev.time} 开始（${label}后）`,
      timestamp: now
    });
  }
}

// 启动提醒轮询（需在 store.init 之后调用）
function startReminder(io) {
  checkReminders(io);
  const timer = setInterval(() => checkReminders(io), REMIND_TICK_MS);
  timer.unref();
  return timer;
}

function register(io, socket) {
  // 按月拉取日程（room + YYYY-MM）
  socket.on('cal_events_month', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    const month = String((data && data.month) || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return cb({ ok: false, error: '月份格式无效' });
    if (!canAccessRoom(room, socket.data.clientId)) {
      return cb({ ok: false, error: '你不在该房间中' });
    }
    try {
      // 多取前后各 7 天，覆盖月视图露出的邻月日期
      const [y, m] = month.split('-').map(Number);
      const from = new Date(y, m - 1, -6);
      const to = new Date(y, m, 7);
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      cb({ ok: true, events: store.listEvents(room, fmt(from), fmt(to)) });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 添加日程
  socket.on('cal_event_add', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    const date = String((data && data.date) || '');
    const time = String((data && data.time) || '');
    const title = String((data && data.title) || '').trim();
    const note = String((data && data.note) || '').trim();
    if (!canAccessRoom(room, socket.data.clientId)) {
      return cb({ ok: false, error: '你不在该房间中' });
    }
    if (!validDate(date)) return cb({ ok: false, error: '日期无效' });
    if (time && !TIME_RE.test(time)) return cb({ ok: false, error: '时间格式无效' });
    if (!title || title.length > 60) return cb({ ok: false, error: '标题需为 1~60 个字符' });
    if (note.length > 200) return cb({ ok: false, error: '备注最多 200 字' });
    let remind = 0;
    if (data && data.remind !== undefined && data.remind !== null && data.remind !== '') {
      remind = Number(data.remind);
      if (!Number.isInteger(remind) || remind < 0 || remind > 1440) {
        return cb({ ok: false, error: '提醒档位无效' });
      }
    }
    if (!time) remind = 0; // 未设时间的日程不能提醒
    try {
      const id = store.createEvent({
        room, event_date: date, event_time: time, title, note,
        creator_client_id: socket.data.clientId || '',
        creator_nick: socket.data.nickname,
        created_at: Date.now(),
        remind_minutes: remind
      });
      io.to(room).emit('cal_event_changed', { room, action: 'add' });
      cb({ ok: true, event: store.getEvent(id) });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 删除日程（创建者本人或宿主机）
  socket.on('cal_event_delete', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const id = Number(data && data.id);
    if (!Number.isInteger(id) || id <= 0) return cb({ ok: false, error: '参数无效' });
    let ev;
    try { ev = store.getEvent(id); } catch (e) { return cb({ ok: false, error: e.message }); }
    if (!ev) return cb({ ok: false, error: '日程不存在' });
    const isCreator = !!(socket.data.clientId && socket.data.clientId === ev.creatorClientId);
    if (!isCreator && !isLocalSocket(socket)) {
      return cb({ ok: false, error: '只能删除自己创建的日程' });
    }
    try {
      store.deleteEvent(id);
      io.to(ev.room).emit('cal_event_changed', { room: ev.room, action: 'delete' });
      cb({ ok: true });
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 一键拉会：算出该日程所在房间当前在线的可呼叫成员（排除自己；按 clientId 匹配成员）
  socket.on('cal_meeting_targets', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const id = Number(data && data.id);
    let ev;
    try { ev = store.getEvent(id); } catch (e) { return cb({ ok: false, error: e.message }); }
    if (!ev) return cb({ ok: false, error: '日程不存在' });
    if (!canAccessRoom(ev.room, socket.data.clientId)) {
      return cb({ ok: false, error: '你不在该房间中' });
    }
    const targets = [];
    if (ev.room === 'main') {
      for (const sid of onlineUsers.keys()) {
        if (sid !== socket.id) targets.push(sid);
      }
    } else {
      const gr = groupRooms.get(ev.room);
      if (gr) {
        const memberCids = new Set(gr.members.map((m) => m.clientId));
        for (const s of io.sockets.sockets.values()) {
          const cid = String((s.handshake.auth && s.handshake.auth.clientId) || '');
          if (s.id !== socket.id && memberCids.has(cid)) targets.push(s.id);
        }
      }
    }
    cb({ ok: true, targets, room: ev.room });
  });
}

module.exports = { registerRoutes, register, expandYear, startReminder, checkReminders };
