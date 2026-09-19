/* client.js —— 客户端壳 / 组合根：
 * 负责初始化 socket 与共享状态、移动端布局、未读通知基建、主题、昵称编辑、
 * welcome 编排，并把各功能分片（call/chat/rooms/members/emoji/autocomplete/upload）
 * 在 Node 与浏览器两种通道下装配起来。
 * 浏览器下分片经 <script> 在 client.js 之后加载；Node 冒烟测试下由本入口 require。 */
(function () {
  'use strict';

  // Node（冒烟测试）下由本入口装配各分片。先加载基础模块（utils/state），
  // 待 socket 创建并挂到 app.socket 后再加载功能分片；浏览器下分片经 <script> 在 client.js 之后加载
  if (typeof module !== 'undefined' && module.exports) {
    require('./client-parts/util.js');
    require('./client-parts/state.js');
  }

  // 共享运行时状态：client-parts/state.js 创建（含持久身份 myClientId 初始化），
  // 通话/消息/群聊等全部功能分片读写同一对象
  const app = window.chatApp;
  const state = app.state;

  // 握手带持久 clientId：服务端据此下发我加入的群聊房并自动加入对应 Socket.IO room
  // 握手带 joinToken（来自 ?join= 邀请链接）：服务端命中群聊房则自动成为成员并入房
  // 公网邀请模式：握手带会话 token（登录后存入 localStorage），服务端签发身份
  const joinParams = typeof location !== 'undefined' && location.search ? new URLSearchParams(location.search) : null;
  const joinToken = joinParams ? (joinParams.get('join') || '') : '';
  let sessionToken = '';
  try { sessionToken = localStorage.getItem('localsend-session-token') || ''; } catch (_) { /* 非浏览器 */ }
  const socket = io({ auth: { clientId: state.myClientId, ...(sessionToken ? { sessionToken } : {}), ...(joinToken ? { joinToken } : {}) } });
  // 功能分片在 Node require 期即需取用 socket（浏览器由底部导出设置，此赋值幂等）
  app.socket = socket;

  // 公网邀请模式：会话失效/未登录 → 跳登录页；退出登录后回登录页
  socket.on('auth_required', () => {
    try { localStorage.removeItem('localsend-session-token'); } catch (_) { /* ignore */ }
    if (typeof location !== 'undefined') location.href = '/join.html';
  });
  const logoutBtn = typeof document !== 'undefined' ? document.getElementById('logoutBtn') : null;
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* 忽略网络错误 */ }
      try { localStorage.removeItem('localsend-session-token'); } catch (_) { /* ignore */ }
      location.href = '/join.html';
    });
    // invite 模式且有会话才显示退出按钮
    fetch('/api/auth/status').then((r) => r.json()).then((s) => {
      if (s && s.mode === 'invite' && s.authed) logoutBtn.hidden = false;
    }).catch(() => { /* ignore */ });
  }

  if (typeof module !== 'undefined' && module.exports) {
    require('./client-parts/call.js');
    require('./client-parts/chat.js');
    require('./client-parts/rooms.js');
    require('./client-parts/members.js');
    require('./client-parts/emoji.js');
    require('./client-parts/autocomplete.js');
    require('./client-parts/upload.js');
    require('./client-parts/dl-core.js');
  }

  // ---------- DOM 引用（壳用；各分片自取自己的 DOM） ----------
  const connStatus = document.getElementById('connStatus');
  const myNameEl = document.getElementById('myName');
  const onlineCount = document.getElementById('onlineCount');
  const uploadHint = document.getElementById('uploadHint');
  const unreadPill = document.getElementById('unreadPill');
  const unreadPillText = document.getElementById('unreadPillText');
  const myNameInput = document.getElementById('myNameInput');
  const nickError = document.getElementById('nickError');
  const chatArea = document.getElementById('chatArea');
  // 移动端
  const sidebarToggle = document.getElementById('sidebarToggle');
  const drawerBackdrop = document.getElementById('drawerBackdrop');
  const mobileRoomBar = document.getElementById('mobileRoomBar');

  // ---------- 工具函数（来自 client-parts/util.js；双通道：Node 由本文件 require，浏览器由 <script> 先加载） ----------
  const { pad, fmtTime, fmtSize, escapeHtml, mostlyCJK } = app.utils;

  // ---------- 移动端布局：检测宽度，控制 ☰ 按钮 / 底部房间栏 / 抽屉初始态 ----------
  function isMobile() {
    return window.innerWidth <= 720;
  }

  function applyMobileLayout() {
    const mobile = isMobile();
    if (sidebarToggle) sidebarToggle.hidden = !mobile;
    if (mobileRoomBar) mobileRoomBar.hidden = !mobile;
    if (!mobile) closeDrawer();
  }

  // 用 matchMedia 与 CSS 媒体查询严格同步（Edge/Chrome 设备模拟不触发 resize，
  // 但媒体查询状态变化必然触发 change；与 CSS 断点保持一致）
  const mobileMQ = window.matchMedia ? window.matchMedia('(max-width: 720px)') : null;
  function syncMobileLayout() {
    applyMobileLayout();
  }

  function openDrawer() {
    const sb = document.querySelector('.sidebar');
    if (!sb) return;
    sb.classList.add('open');
    if (drawerBackdrop) drawerBackdrop.hidden = false;
  }

  function closeDrawer() {
    const sb = document.querySelector('.sidebar');
    if (sb) sb.classList.remove('open');
    if (drawerBackdrop) drawerBackdrop.hidden = true;
  }

  function toggleDrawer() {
    const sb = document.querySelector('.sidebar');
    if (sb && sb.classList.contains('open')) closeDrawer();
    else openDrawer();
  }

  const NICK_STORAGE_KEY = 'localsend-nickname';
  // 会话身份 / 群聊房间 / 未读 / 成员 / 通话 / 消息 等运行时状态
  // 全部位于 client-parts/state.js 的 window.chatApp.state

  // ---------- 聊天区基建（chat/rooms 分片经 app.* 复用） ----------
  const SCROLL_THRESHOLD = 60;

  function isNearBottom() {
    return chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < SCROLL_THRESHOLD;
  }

  function scrollToBottom(smooth) {
    chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function appendMsg(node) {
    // 先在追加前判断用户是否停在底部附近（追加后距离会变，长消息会超出阈值导致误判）
    const wasNear = isNearBottom();
    chatArea.appendChild(node);
    // 用户停留在底部附近 → 滚到最新；翻看历史时不动滚动条
    if (wasNear) chatArea.scrollTop = chatArea.scrollHeight;
  }

  // 历史分页：把更早的消息插到最顶部（不触发滚动）
  function prependMsg(node) {
    chatArea.insertBefore(node, chatArea.firstChild);
  }

  // 页内提示条（各分片经 app.setHint 复用）
  function setHint(text, cls) {
    uploadHint.textContent = text;
    uploadHint.className = 'upload-hint show' + (cls ? ' ' + cls : '');
  }

  // ---------- 未读消息提醒（标签页红点 / 标题计数 / 桌面通知 / 提示音 / 页内浮条） ----------
  const BASE_TITLE = document.title;

  // 生成 favicon：蓝色圆底 + 白色圆点，有未读时右上角画红点与数字
  function drawFavicon(count) {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#4f6ef7';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(16, 16, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    if (count > 0) {
      const r = count > 9 ? 10 : 8;
      ctx.beginPath();
      ctx.arc(26, 6, r, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(count > 99 ? '99+' : String(count), 26, 7);
    }
    return canvas.toDataURL('image/png');
  }

  function updateTabIndicator() {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = drawFavicon(state.unreadCount);
    document.title = state.unreadCount > 0 ? `(${state.unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
  }

  // 桌面通知（需用户授权；授权在首次交互时请求）
  function ensureNotifPermission() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    Notification.requestPermission().catch(() => {});
  }

  function notifyDesktop(data) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    let body = '';
    if (data.type === 'image') body = '[图片] ' + (data.fileName || '');
    else if (data.type === 'file') body = '[文件] ' + (data.fileName || '');
    else body = data.text || '';
    try {
      const title = data.mentionAll ? `${data.nickname} @了所有人`
        : (data.mention ? `${data.nickname} 提到了你` : `${data.nickname} 发来消息`);
      const n = new Notification(title, {
        body: body.slice(0, 80),
        icon: drawFavicon(0),
        tag: 'chat-' + data.timestamp
      });
      n.onclick = () => { window.focus(); resetUnread(); };
    } catch (_) { /* 忽略通知失败 */ }
  }

  // 提示音：Web Audio 两段短音（叮咚），无需音频文件（state.audioCtx 见 state.js）
  function playPing() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!state.audioCtx) state.audioCtx = new AC();
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
      [880, 1174].forEach((freq, i) => {
        const osc = state.audioCtx.createOscillator();
        const gain = state.audioCtx.createGain();
        const t0 = state.audioCtx.currentTime + i * 0.12;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        osc.connect(gain).connect(state.audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.22);
      });
    } catch (_) { /* 忽略音频失败 */ }
  }

  // @提及提示音：三连高音上行，与普通消息双音区分
  function playMentionPing() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!state.audioCtx) state.audioCtx = new AC();
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
      [988, 1319, 1568].forEach((freq, i) => {
        const osc = state.audioCtx.createOscillator();
        const gain = state.audioCtx.createGain();
        const t0 = state.audioCtx.currentTime + i * 0.09;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        osc.connect(gain).connect(state.audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.2);
      });
    } catch (_) { /* 忽略音频失败 */ }
  }

  // 页内"新消息"浮条（滚动到上方看历史时提示，与页面是否聚焦无关）
  function showUnreadPill() {
    unreadPillText.textContent = `${state.pillCount} 条新消息`;
    unreadPill.classList.add('show');
  }

  function hideUnreadPill() {
    unreadPill.classList.remove('show');
  }

  // 浮条清零：滚到底部 / 点浮条 / 自己发消息时调用
  function resetPill() {
    state.pillCount = 0;
    hideUnreadPill();
  }

  // 页面未聚焦未读清零（标签页标题 / favicon），不影响页内浮条
  function resetUnread() {
    if (state.unreadCount === 0) return;
    state.unreadCount = 0;
    updateTabIndicator();
  }

  // 收到消息后的提醒：@提及时播放专属提示音；滚到上方时累计浮条；未聚焦时累计标签页未读
  function handleIncomingMessage(data) {
    if (app.isOwnMessage(data)) return;
    const mentioned = data.mentionAll === true || app.utils.hasMentionAll(data.text) || (data.mentions || []).includes(state.myNickname);
    if (mentioned) playMentionPing();
    // 页内浮条：滚动到上方看历史时来消息 → 提示"新消息 N 条"（无论页面是否聚焦）
    if (!isNearBottom()) {
      state.pillCount++;
      showUnreadPill();
    }
    if (document.hasFocus()) return;
    // 页面未聚焦：标签页标题 / favicon / 桌面通知 / 提示音
    state.unreadCount++;
    updateTabIndicator();
    if (document.visibilityState === 'hidden') notifyDesktop(mentioned ? { ...data, mention: true } : data);
    if (!mentioned) playPing();
  }

  // ---------- Socket 事件 ----------
  socket.on('connect', () => {
    connStatus.textContent = '已连接';
    connStatus.className = 'badge online';
  });

  socket.on('disconnect', () => {
    connStatus.textContent = '已断开';
    connStatus.className = 'badge offline';
  });

  socket.on('welcome', (data) => {
    state.myNickname = data.nickname;
    state.myId = data.id || '';
    // 服务端签发的身份（公网邀请模式下为账号 id；LAN 下与本地生成值一致）
    if (data.clientId) {
      state.myClientId = data.clientId;
      try { localStorage.setItem('localsend-client-id', state.myClientId); } catch (_) { /* ignore */ }
    }
    state.isLocalHost = !!data.isLocal;
    myNameEl.textContent = state.myNickname;
    app.renderSystemMsg({
      text: `你已加入聊天室，你的昵称是 ${state.myNickname}`
    });
    onlineCount.textContent = data.online;
    // 加载最近历史消息（SQLite 持久化）
    if (Array.isArray(data.history) && data.history.length) {
      const sep = document.createElement('div');
      sep.className = 'msg system';
      sep.innerHTML = `<div class="msg-bubble">—— 以下为最近 ${data.history.length} 条历史消息 ——</div>`;
      appendMsg(sep);
      data.history.forEach((m) => {
        if (!m || m.recalled) return;
        if (m.id) state.msgStore.set(m.id, m);
        if (m.type === 'image') app.renderImageMsg(m);
        else if (m.type === 'file') app.renderFileMsg(m);
        else app.renderTextMsg(m);
      });
      const sepEnd = document.createElement('div');
      sepEnd.className = 'msg system';
      sepEnd.innerHTML = `<div class="msg-bubble">—— 历史消息结束 ——</div>`;
      appendMsg(sepEnd);
      scrollToBottom(false);
    }
    // 恢复上次使用的昵称（静默改名，不广播系统消息；被占用则放弃）
    let saved = null;
    try { saved = localStorage.getItem(NICK_STORAGE_KEY); } catch (_) { /* ignore */ }
    if (saved && saved !== state.myNickname) {
      socket.emit('set_nickname', { name: saved, silent: true }, (res) => {
        if (res && res.ok) {
          applyNickname(res.nickname);
        } else {
          try { localStorage.removeItem(NICK_STORAGE_KEY); } catch (_) { /* ignore */ }
        }
      });
    }
    // 恢复我加入的群聊房（房间持久化：重启后仍在）
    state.myRooms = Array.isArray(data.rooms) ? data.rooms : [];
    app.renderRoomList();
    // 初始化历史分页状态（welcome 已带最近历史）
    app.initHistoryState(Array.isArray(data.history) ? data.history : []);
    // 进房即已读：向服务器上报"已读到最新"
    if (app.markHistoryRead) app.markHistoryRead('main', Array.isArray(data.history) ? data.history : []);
    // 公共房群公告 + 置顶列表（切房时由 room_history 刷新）
    if (data.announcement && data.announcement.text) {
      state.announcement.set('main', { text: data.announcement.text, author: data.announcement.author, updatedAt: data.announcement.updatedAt });
    } else {
      state.announcement.delete('main');
    }
    state.pins.set('main', Array.isArray(data.pins) ? data.pins : []);
    if (app.renderAnnouncement) app.renderAnnouncement('main', state.announcement.get('main') || null);
    if (app.renderPins) app.renderPins('main', state.pins.get('main') || []);
    if (app.updateRoomTitlebar) app.updateRoomTitlebar();
    // 通过邀请链接加入成功 → 从地址栏去掉 ?join=，避免每次刷新都重新加入
    if (joinToken && typeof history !== 'undefined' && history.replaceState) {
      try { history.replaceState(null, '', location.pathname); } catch (_) { /* ignore */ }
    }
  });

  socket.on('system_message', (data) => {
    // 群聊系统消息带 room：只渲染当前房间的；公共房系统消息无 room 字段
    if (data && data.room && data.room !== state.currentRoom) return;
    app.renderSystemMsg(data);
  });

  // ---------- 移动端布局：抽屉开关 + 底部房间栏 ----------
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggleDrawer);
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);

  // 初始化 + 窗口尺寸变化时刷新移动端布局
  applyMobileLayout();
  // 优先用 matchMedia：与 CSS 媒体查询严格同步（设备模拟不触发 resize 也能生效）
  if (mobileMQ && mobileMQ.addEventListener) {
    mobileMQ.addEventListener('change', () => applyMobileLayout());
  }
  // resize 兜底（普通拖拽窗口 / 老浏览器）
  window.addEventListener('resize', () => {
    applyMobileLayout();
  });

  // ---------- 未读提醒的初始化 ----------
  // 回到页面 / 窗口获得焦点 → 清空未读
  window.addEventListener('focus', resetUnread);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resetUnread();
  });
  // 滚动回底部 → 清浮条
  chatArea.addEventListener('scroll', () => {
    if (isNearBottom()) resetPill();
  });
  // 点击浮条 → 清未读/浮条并滚到底部
  unreadPill.addEventListener('click', () => {
    resetUnread();
    resetPill();
    scrollToBottom(true);
  });
  // 桌面通知权限必须在用户手势中请求：首次点击/按键时尝试
  ['pointerdown', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, ensureNotifPermission, { capture: true, once: true });
  });
  // 初始 favicon（蓝色圆点）
  updateTabIndicator();

  // ---------- 深色 / 浅色主题切换 ----------
  const THEME_STORAGE_KEY = 'localsend-theme';
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch (_) { /* ignore */ }
    });
  }

  // ---------- 昵称修改（点击顶栏昵称内联编辑） ----------
  function applyNickname(name) {
    state.myNickname = name;
    myNameEl.textContent = name;
    try { localStorage.setItem(NICK_STORAGE_KEY, name); } catch (_) { /* ignore */ }
  }

  function showNickError(text) {
    nickError.textContent = text;
    nickError.hidden = false;
    clearTimeout(state.nickErrorTimer);
    state.nickErrorTimer = setTimeout(() => { nickError.hidden = true; }, 3000);
  }

  function closeNickEditor() {
    myNameInput.hidden = true;
    myNameEl.hidden = false;
    state.nickEditing = false;
  }

  function submitNickname() {
    if (!state.nickEditing) return;
    const name = myNameInput.value.trim();
    if (!name || name === state.myNickname) {
      closeNickEditor();
      return;
    }
    socket.emit('set_nickname', { name }, (res) => {
      if (res && res.ok) {
        applyNickname(res.nickname);
      } else {
        showNickError((res && res.error) || '修改昵称失败');
      }
      closeNickEditor();
    });
  }

  myNameEl.addEventListener('click', () => {
    if (state.nickEditing) return;
    state.nickEditing = true;
    myNameInput.value = state.myNickname;
    myNameEl.hidden = true;
    myNameInput.hidden = false;
    myNameInput.focus();
    myNameInput.select();
  });
  myNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNickname();
    } else if (e.key === 'Escape') {
      closeNickEditor();
    }
  });
  myNameInput.addEventListener('blur', submitNickname);

  // 防止浏览器直接打开拖入文件
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // 暴露给各功能分片（share/whiteboard/screen-share/data-panel/calendar 等复用同一 socket 与工具函数）
  // state 为共享运行时状态对象，各分片经 window.chatApp.state 读写同一份状态。
  // 注意：getter 必须用 defineProperty 定义——Object.assign 会把源 getter 快照成静态值，
  // 导致 isLocal/rooms/nickname 停在加载时（false/[]/''），welcome 后的宿主机门禁与房间查找全失效。
  const chatApp = window.chatApp || {};
  chatApp.socket = socket;
  chatApp.state = state;
  chatApp.utils = Object.assign({}, chatApp.utils || {}, { fmtTime, fmtSize, escapeHtml });
  Object.defineProperty(chatApp, 'nickname', { get: () => state.myNickname, enumerable: true, configurable: true });
  Object.defineProperty(chatApp, 'isLocal', { get: () => state.isLocalHost, enumerable: true, configurable: true });
  Object.defineProperty(chatApp, 'rooms', { get: () => state.myRooms, enumerable: true, configurable: true });
  Object.defineProperty(chatApp, 'clientId', { get: () => state.myClientId, enumerable: true, configurable: true });
  // 壳提供的跨分片基建
  Object.assign(chatApp, {
    setHint,
    appendMsg,
    prependMsg,
    isNearBottom,
    scrollToBottom,
    drawFavicon,
    handleIncomingMessage,
    hideUnreadPill,
    resetUnread,
    resetPill,
    closeDrawer,
    openDrawer
  });
  window.chatApp = chatApp;
})();
