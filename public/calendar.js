/* 日历：月/年视图（节假日 + 农历 + 节气）+ 共享日程（房间隔离、实时同步） */
(function () {
  'use strict';

  if (!window.chatApp) return; // 依赖 client.js / share.js 先加载
  const socket = window.chatApp.socket;
  const { escapeHtml } = window.chatApp.utils;

  // ---------- DOM ----------
  const tabCalendar = document.getElementById('tabCalendar');
  const calendarView = document.getElementById('calendarView');
  const calRoomSelect = document.getElementById('calRoomSelect');
  const calTitle = document.getElementById('calTitle');
  const calGrid = document.getElementById('calGrid');
  const calYearGrid = document.getElementById('calYearGrid');
  const calOfficialTip = document.getElementById('calOfficialTip');
  const calModeBtn = document.getElementById('calModeBtn');

  const dayModal = document.getElementById('calDayModal');
  const calDayTitle = document.getElementById('calDayTitle');
  const calDaySub = document.getElementById('calDaySub');
  const calDayHoliday = document.getElementById('calDayHoliday');
  const calEventList = document.getElementById('calEventList');
  const calEvTitle = document.getElementById('calEvTitle');
  const calEvTime = document.getElementById('calEvTime');
  const calEvRemind = document.getElementById('calEvRemind');
  const calEvNote = document.getElementById('calEvNote');
  const todayBanner = document.getElementById('todayBanner');
  const calEvAddBtn = document.getElementById('calEvAddBtn');
  const calEvError = document.getElementById('calEvError');

  // ---------- 状态 ----------
  const now = new Date();
  let viewY = now.getFullYear();
  let viewM = now.getMonth() + 1; // 1-based
  let mode = 'month';             // 'month' | 'year'
  let activeRoom = 'main';
  let selectedDate = null;        // 弹窗当前日期 'YYYY-MM-DD'
  const holidaysCache = new Map(); // year -> { official, days }
  let eventsByDate = new Map();    // date -> [event,...]（当前视图月份）

  const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

  window.chatApp.registerTab('calendar', tabCalendar, [calendarView]);

  // ---------- 工具 ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function ds(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
  function todayStr() {
    const t = new Date();
    return ds(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }

  // 某日的农历信息（库缺失时优雅降级）
  function lunarOf(y, m, d) {
    if (!window.Solar) return { text: '', festival: '', jieqi: '' };
    try {
      const l = window.Solar.fromYmd(y, m, d).getLunar();
      const jieqi = l.getJieQi() || '';
      const fests = (l.getFestivals() || []).concat(l.getOtherFestivals() || []);
      let text;
      if (l.getDay() === 1) text = l.getMonthInChinese() + '月';
      else if (l.getDay() === 15) text = '十五';
      else text = l.getDayInChinese();
      return { text, festival: fests[0] || '', jieqi };
    } catch (_) {
      return { text: '', festival: '', jieqi: '' };
    }
  }

  // ---------- 节假日数据 ----------
  async function fetchHolidays(year) {
    if (holidaysCache.has(year)) return holidaysCache.get(year);
    let data = { official: false, days: {} };
    try {
      const r = await fetch(`/api/calendar/year?year=${year}`);
      const j = await r.json();
      if (j && j.ok) data = { official: j.official, days: j.days || {} };
    } catch (_) { /* 网络失败按无表降级 */ }
    holidaysCache.set(year, data);
    return data;
  }

  async function holidaysOf(y, m) {
    // 月视图会露出邻月日期，跨年边界时把两个年份都取到
    const cur = await fetchHolidays(y);
    if (m === 1) await fetchHolidays(y - 1);
    if (m === 12) await fetchHolidays(y + 1);
    return cur;
  }

  function holidayEntry(dateStr) {
    const y = Number(dateStr.slice(0, 4));
    const h = holidaysCache.get(y);
    return h && h.days ? h.days[dateStr] || null : null;
  }

  function anyYearOfficial(y) {
    const h = holidaysCache.get(y);
    return !!(h && h.official);
  }

  // ---------- 共享日程 ----------
  function roomName(id) {
    if (id === 'main') return '公共房';
    const r = (window.chatApp.rooms || []).find((x) => x.id === id);
    return r && r.name ? r.name : '群聊';
  }

  function renderRoomSelect() {
    const rooms = window.chatApp.rooms || [];
    const opts = [`<option value="main">公共房日程</option>`]
      .concat(rooms.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(roomName(r.id))}日程</option>`));
    calRoomSelect.innerHTML = opts.join('');
    calRoomSelect.value = activeRoom;
    if (calRoomSelect.value !== activeRoom) {
      activeRoom = 'main';
      calRoomSelect.value = 'main';
    }
  }

  function reloadEvents() {
    const month = `${viewY}-${pad(viewM)}`;
    socket.emit('cal_events_month', { room: activeRoom, month }, (res) => {
      if (!res || !res.ok) return;
      eventsByDate = new Map();
      for (const ev of res.events || []) {
        if (!eventsByDate.has(ev.date)) eventsByDate.set(ev.date, []);
        eventsByDate.get(ev.date).push(ev);
      }
      render();
      if (selectedDate && !dayModal.hidden) renderEventList();
    });
  }

  // ---------- 月视图 ----------
  function buildCell(y, m, d, inMonth) {
    const dateStr = ds(y, m, d);
    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (inMonth ? '' : ' dim');
    const lunar = lunarOf(y, m, d);
    const hol = holidayEntry(dateStr);
    const isWeekend = [0, 6].includes(new Date(y, m - 1, d).getDay());

    if (dateStr === todayStr()) cell.classList.add('today');
    if (hol && hol.type === 'holiday') cell.classList.add('is-rest');
    if (hol && hol.type === 'workday') cell.classList.add('is-work');
    if (!hol && isWeekend) cell.classList.add('weekend');

    let badge = '';
    if (hol && hol.type === 'holiday') badge = '<span class="cal-badge rest">休</span>';
    else if (hol && hol.type === 'workday') badge = '<span class="cal-badge work">班</span>';

    // 副标题：传统节日 > 节气 > 农历日期
    let sub = lunar.text;
    let subCls = 'cal-lunar';
    if (lunar.festival) { sub = lunar.festival; subCls = 'cal-festival'; }
    else if (lunar.jieqi) { sub = lunar.jieqi; subCls = 'cal-jieqi'; }

    const events = eventsByDate.get(dateStr) || [];
    let dots = '';
    if (events.length) {
      const shown = Math.min(events.length, 3);
      dots = '<span class="cal-dots">' + '<i class="cal-dot"></i>'.repeat(shown) +
        (events.length > 3 ? `<em class="cal-dot-n">${events.length}</em>` : '') + '</span>';
    }

    cell.innerHTML = `
      <div class="cal-day-row"><span class="cal-day-num">${d}</span>${badge}</div>
      <div class="${subCls}">${escapeHtml(sub)}</div>
      ${hol && hol.name && hol.type === 'holiday' && hol.total > 1 ? `<div class="cal-hol-name">${escapeHtml(hol.name)}</div>` : ''}
      ${dots}`;
    cell.title = dateStr + (hol && hol.name ? ` ${hol.name}` : '') + (events.length ? ` · ${events.length} 条日程` : '');
    cell.addEventListener('click', () => openDay(dateStr));
    return cell;
  }

  function renderMonth() {
    calTitle.textContent = `${viewY} 年 ${viewM} 月`;
    calGrid.innerHTML = '';
    for (const w of WEEKDAYS) {
      const h = document.createElement('div');
      h.className = 'cal-weekday';
      h.textContent = w;
      calGrid.appendChild(h);
    }
    // 周一为一周之始：1号往前推 offset 天
    const first = new Date(viewY, viewM - 1, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(viewY, viewM - 1, 1 - offset);
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      calGrid.appendChild(buildCell(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getMonth() + 1 === viewM));
    }
  }

  // ---------- 年视图 ----------
  function renderYear() {
    calTitle.textContent = `${viewY} 年`;
    calYearGrid.innerHTML = '';
    for (let m = 1; m <= 12; m++) {
      const box = document.createElement('div');
      box.className = 'cal-mini';
      box.innerHTML = `<div class="cal-mini-title">${m} 月</div>`;
      const grid = document.createElement('div');
      grid.className = 'cal-mini-grid';
      for (const w of WEEKDAYS) {
        const h = document.createElement('span');
        h.className = 'cal-mini-wd';
        h.textContent = w;
        grid.appendChild(h);
      }
      const first = new Date(viewY, m - 1, 1);
      const offset = (first.getDay() + 6) % 7;
      const dim = new Date(viewY, m, 0).getDate();
      for (let i = 0; i < offset; i++) grid.appendChild(document.createElement('span'));
      for (let d = 1; d <= dim; d++) {
        const dateStr = ds(viewY, m, d);
        const c = document.createElement('span');
        c.className = 'cal-mini-day';
        c.textContent = d;
        const hol = holidayEntry(dateStr);
        if (dateStr === todayStr()) c.classList.add('today');
        if (hol && hol.type === 'holiday') c.classList.add('is-rest');
        if (hol && hol.type === 'workday') c.classList.add('is-work');
        c.addEventListener('click', () => {
          viewM = m;
          setMode('month');
        });
        grid.appendChild(c);
      }
      box.appendChild(grid);
      calYearGrid.appendChild(box);
    }
  }

  function render() {
    const inMonth = mode === 'month';
    calGrid.hidden = !inMonth;
    calYearGrid.hidden = inMonth;
    calModeBtn.textContent = inMonth ? '年视图' : '月视图';
    if (inMonth) renderMonth(); else renderYear();
    // 放假安排收录提示
    calOfficialTip.hidden = anyYearOfficial(viewY);
    if (!anyYearOfficial(viewY)) {
      calOfficialTip.textContent = `${viewY} 年放假调休安排暂未收录，仅显示传统节日与节气（可在 holidays.json 中补充）`;
    }
  }

  function setMode(m) {
    mode = m;
    render();
  }

  // ---------- 日期详情弹窗 ----------
  function openDay(dateStr) {
    selectedDate = dateStr;
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const lunar = lunarOf(y, m, d);
    calDayTitle.textContent = `${y} 年 ${m} 月 ${d} 日 · 星期${'日一二三四五六'[date.getDay()]}`;
    let lunarFull = '';
    if (window.Solar) {
      try {
        const l = window.Solar.fromYmd(y, m, d).getLunar();
        lunarFull = `农历${l.getMonthInChinese()}月${l.getDayInChinese()}`;
        if (lunar.jieqi) lunarFull += ` · 节气：${lunar.jieqi}`;
        if (lunar.festival) lunarFull += ` · ${lunar.festival}`;
      } catch (_) { /* ignore */ }
    }
    calDaySub.textContent = lunarFull;

    const hol = holidayEntry(dateStr);
    calDayHoliday.hidden = !hol;
    if (hol) {
      if (hol.type === 'workday') {
        calDayHoliday.className = 'cal-day-holiday work';
        calDayHoliday.textContent = '调休上班（工作日）';
      } else {
        calDayHoliday.className = 'cal-day-holiday rest';
        calDayHoliday.textContent = hol.total > 1
          ? `${hol.name}假期 · 第 ${hol.index} 天 / 共 ${hol.total} 天`
          : `${hol.name}（休）`;
      }
    }
    calEvError.hidden = true;
    calEvTitle.value = '';
    calEvNote.value = '';
    renderEventList();
    dayModal.hidden = false;
  }

  function renderEventList() {
    const events = eventsByDate.get(selectedDate) || [];
    calEventList.innerHTML = '';
    if (!events.length) {
      calEventList.innerHTML = '<div class="data-empty">这一天还没有日程</div>';
      return;
    }
    const myCid = window.chatApp.clientId;
    const isAdmin = !!window.chatApp.isLocal;
    const REMIND_TEXT = { 10: '提前10分钟', 30: '提前30分钟', 60: '提前1小时', 1440: '提前1天' };
    for (const ev of events) {
      const row = document.createElement('div');
      row.className = 'cal-event';
      const canDel = isAdmin || (myCid && ev.creatorClientId === myCid);
      const remindBadge = ev.remindMinutes > 0
        ? `<span class="cal-event-remind" title="到点向房间发送提醒">🔔 ${REMIND_TEXT[ev.remindMinutes] || `提前${ev.remindMinutes}分钟`}</span>`
        : '';
      row.innerHTML = `
        <span class="cal-event-time">${escapeHtml(ev.time || '全天')}</span>
        <div class="cal-event-body">
          <div class="cal-event-title">${escapeHtml(ev.title)} ${remindBadge}</div>
          ${ev.note ? `<div class="cal-event-note">${escapeHtml(ev.note)}</div>` : ''}
          <div class="cal-event-creator">${escapeHtml(ev.creatorNick || '')}</div>
        </div>
        <button class="cal-event-call" type="button" title="就这个日程拉起语音会议">📞</button>
        ${canDel ? '<button class="quote-preview-x cal-event-del" type="button" title="删除">×</button>' : ''}`;
      row.querySelector('.cal-event-call').addEventListener('click', () => {
        socket.emit('cal_meeting_targets', { id: ev.id }, (res) => {
          if (!res || !res.ok) return showEvError((res && res.error) || '无法发起会议');
          if (!res.targets || !res.targets.length) return showEvError('当前没有可呼叫的在线成员');
          if (window.chatApp.callTargets) {
            window.chatApp.callTargets(res.targets);
            dayModal.hidden = true;
          }
        });
      });
      if (canDel) {
        row.querySelector('.cal-event-del').addEventListener('click', () => {
          socket.emit('cal_event_delete', { id: ev.id }, (res) => {
            if (!res || !res.ok) showEvError((res && res.error) || '删除失败');
          });
        });
      }
      calEventList.appendChild(row);
    }
  }

  function showEvError(text) {
    calEvError.textContent = text;
    calEvError.hidden = !text;
  }

  // 未填时间时禁用提醒档位（服务器同样会强制归零，双保险）
  function syncRemindState() {
    calEvRemind.disabled = !calEvTime.value;
    if (!calEvTime.value) calEvRemind.value = '0';
  }
  calEvTime.addEventListener('change', syncRemindState);

  calEvAddBtn.addEventListener('click', () => {
    const title = calEvTitle.value.trim();
    if (!title) return showEvError('请填写日程标题');
    calEvAddBtn.disabled = true;
    socket.emit('cal_event_add', {
      room: activeRoom,
      date: selectedDate,
      time: calEvTime.value || '',
      title,
      note: calEvNote.value.trim(),
      remind: calEvTime.value ? Number(calEvRemind.value) : 0
    }, (res) => {
      calEvAddBtn.disabled = false;
      if (!res || !res.ok) return showEvError((res && res.error) || '添加失败');
      calEvTitle.value = '';
      calEvNote.value = '';
      calEvRemind.value = '0';
      showEvError('');
    });
  });

  document.getElementById('calDayClose').addEventListener('click', () => {
    dayModal.hidden = true;
    selectedDate = null;
  });
  dayModal.querySelector('.modal-backdrop').addEventListener('click', () => {
    dayModal.hidden = true;
    selectedDate = null;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dayModal.hidden) {
      dayModal.hidden = true;
      selectedDate = null;
    }
  });

  // ---------- 导航 ----------
  function shiftMonth(delta) {
    viewM += delta;
    if (viewM < 1) { viewM = 12; viewY--; }
    if (viewM > 12) { viewM = 1; viewY++; }
    refresh();
  }
  document.getElementById('calPrevMonth').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('calNextMonth').addEventListener('click', () => shiftMonth(1));
  document.getElementById('calPrevYear').addEventListener('click', () => { viewY--; refresh(); });
  document.getElementById('calNextYear').addEventListener('click', () => { viewY++; refresh(); });
  document.getElementById('calTodayBtn').addEventListener('click', () => {
    const t = new Date();
    viewY = t.getFullYear();
    viewM = t.getMonth() + 1;
    refresh();
  });
  calModeBtn.addEventListener('click', () => setMode(mode === 'month' ? 'year' : 'month'));
  calRoomSelect.addEventListener('change', () => {
    activeRoom = calRoomSelect.value;
    reloadEvents();
  });

  async function refresh() {
    await holidaysOf(viewY, viewM);
    render();
    reloadEvents();
  }

  // 日程变更广播（本房间才刷新）
  socket.on('cal_event_changed', (data) => {
    if (data && data.room === activeRoom) reloadEvents();
  });

  // 群聊房列表可能晚到（welcome 后），进入 Tab 时刷新下拉
  tabCalendar.addEventListener('click', () => {
    renderRoomSelect();
    refresh();
  });

  // ---------- 今日横幅（聊天页顶部：日期/农历/节假日/今日最近日程） ----------
  async function renderTodayBanner() {
    if (!todayBanner) return;
    const t = new Date();
    const y = t.getFullYear();
    const m = t.getMonth() + 1;
    const d = t.getDate();
    const dateStr = ds(y, m, d);
    await fetchHolidays(y);
    const hol = holidayEntry(dateStr);
    const lunar = lunarOf(y, m, d);
    let lunarFull = '';
    if (window.Solar) {
      try {
        const l = window.Solar.fromYmd(y, m, d).getLunar();
        lunarFull = `农历${l.getMonthInChinese()}月${l.getDayInChinese()}`;
      } catch (_) { /* ignore */ }
    }
    const text = [`${m}月${d}日 星期${'日一二三四五六'[t.getDay()]}`];
    if (lunarFull) text.push(lunarFull);
    if (lunar.jieqi) text.push(`节气：${lunar.jieqi}`);
    if (lunar.festival) text.push(lunar.festival);

    let holHtml = '';
    if (hol && hol.type === 'holiday') {
      holHtml = `<span class="tb-holiday">🎉 ${escapeHtml(hol.name)}${hol.total > 1 ? ` · 第 ${hol.index} 天 / 共 ${hol.total} 天` : ''}</span>`;
    } else if (hol && hol.type === 'workday') {
      holHtml = '<span class="tb-work">今天调休上班</span>';
    }

    // 今日最近一条公共房日程（时间未到的第一条）
    socket.emit('cal_events_month', { room: 'main', month: `${y}-${pad(m)}` }, (res) => {
      let evHtml = '';
      if (res && res.ok) {
        const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
        const next = (res.events || [])
          .filter((e) => e.date === dateStr && e.time && e.time >= hm)
          .sort((a, b) => (a.time < b.time ? -1 : 1))[0];
        if (next) evHtml = `<span class="tb-event">📅 ${escapeHtml(next.time)} ${escapeHtml(next.title)}</span>`;
      }
      todayBanner.innerHTML = `<span class="tb-date">${escapeHtml(text.join(' · '))}</span>${holHtml}${evHtml}`;
      todayBanner.hidden = false;
    });
  }

  // ---------- 初始化 ----------
  renderRoomSelect();
  refresh();
  renderTodayBanner();
  setInterval(renderTodayBanner, 30 * 60 * 1000); // 每 30 分钟刷新一次（跨午夜/日程变化）
})();
