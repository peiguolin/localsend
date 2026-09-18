/* chat 社交与历史片：表情回应、已读回执、历史分页懒加载、消息页脚。
 * 内部依赖经 C（app._chat）：渲染函数、isOwnMessage、insertMsgNode。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const C = app._chat;
  const socket = app.socket;
  const state = app.state;
  const { escapeHtml } = app.utils;

  const chatArea = document.getElementById('chatArea');

  // ---------- 历史分页（往上滚懒加载） ----------
  function initHistoryState(history) {
    if (!history) {
      state.oldestId = 0;
      state.historyDone = true;
      state.historyLoading = false;
      return;
    }
    const first = history.find((m) => m && m.numericId);
    state.oldestId = first ? first.numericId : 0;
    state.historyDone = history.length < 200; // 初始不足一页 → 无更早
    state.historyLoading = false;
  }

  let loadMoreEl = null;
  function loadOlderHistory() {
    if (state.historyLoading || state.historyDone || !state.oldestId) return;
    state.historyLoading = true;
    loadMoreEl = document.createElement('div');
    loadMoreEl.className = 'msg system';
    loadMoreEl.innerHTML = '<div class="msg-bubble">加载更早的消息…</div>';
    chatArea.insertBefore(loadMoreEl, chatArea.firstChild);
    socket.emit('history_page', { room: state.currentRoom, beforeId: state.oldestId, limit: 50 }, (res) => {
      if (loadMoreEl) { loadMoreEl.remove(); loadMoreEl = null; }
      if (res && res.ok && Array.isArray(res.history) && res.history.length) {
        res.history.forEach((m) => { if (m && m.id) state.msgStore.set(m.id, m); });
        const prevHeight = chatArea.scrollHeight;
        C.historyPrepend = true;
        // 逆序前插，保持时间升序（每次插到最前，最旧自然落在顶部）
        for (let i = res.history.length - 1; i >= 0; i--) {
          const m = res.history[i];
          if (!m || m.recalled) continue;
          if (m.type === 'image') C.renderImageMsg(m);
          else if (m.type === 'file') C.renderFileMsg(m);
          else C.renderTextMsg(m);
        }
        C.historyPrepend = false;
        const newest = res.history[0];
        state.oldestId = newest && newest.numericId ? newest.numericId : state.oldestId;
        state.historyDone = res.history.length < 50;
        // 补偿新增高度，保持视口位置不动
        chatArea.scrollTop += chatArea.scrollHeight - prevHeight;
      } else {
        state.historyDone = true; // 没有更早消息了
      }
      state.historyLoading = false;
    });
  }

  // 贴近顶部时触发加载更早（滚动事件由壳的未读浮条监听共存）
  chatArea.addEventListener('scroll', () => {
    if (chatArea.scrollTop > 80) return;
    loadOlderHistory();
  });

  // ---------- 已读回执：向服务器上报"我已读到某时间点"，并接收别人已读广播 ----------
  const readSentTs = new Map(); // room -> 已上报的 upToTs（节流，避免滚动时狂发）
  function emitRead(room, upToTs) {
    if (!room || !upToTs) return;
    const last = readSentTs.get(room) || 0;
    if (upToTs <= last) return;
    readSentTs.set(room, upToTs);
    socket.emit('read_messages', { room, upToTs });
  }

  // 历史渲染完成时上报"整屏已读"（welcome / 切房 / 上翻分页）
  function markHistoryRead(room, msgs) {
    if (!Array.isArray(msgs) || !msgs.length) return;
    let max = 0;
    for (const m of msgs) if (m && m.timestamp && m.timestamp > max) max = m.timestamp;
    if (max) emitRead(room, max);
  }

  // 已读回执（✓ 送达 / ✓✓ 已读 N 人）：仅自己的消息显示，读者列表实时广播
  function updateReadIndicator(mid) {
    if (!mid) return;
    const el = chatArea.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
    if (!el) return;
    const tag = el.querySelector('.msg-read');
    if (!tag) return;
    const readers = state.msgReadBy.get(mid) || new Map();
    const n = readers.size;
    if (n === 0) {
      tag.textContent = '✓';
      tag.title = '已送达';
      tag.classList.remove('read');
    } else {
      tag.textContent = `✓✓ ${n}`;
      tag.title = '已读：' + Array.from(readers.values()).join('、');
      tag.classList.add('read');
    }
  }

  // 收到别人已读某批消息的广播 → 更新自己消息上的 ✓✓
  socket.on('messages_read', (data) => {
    if (!data || (data.room || 'main') !== state.currentRoom) return;
    if (!data.clientId || data.clientId === state.myClientId) return;
    const nickname = data.nickname || '某成员';
    const ids = Array.isArray(data.msgIds) ? data.msgIds : [];
    for (const id of ids) {
      let readers = state.msgReadBy.get(id);
      if (!readers) { readers = new Map(); state.msgReadBy.set(id, readers); }
      if (!readers.has(data.clientId)) readers.set(data.clientId, nickname);
      updateReadIndicator(id);
    }
  });

  // ---------- 表情回应（实时广播；reactions 见服务端装饰/reaction 事件） ----------
  const REACTION_QUICK = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👏', '👍🏻', '🙏', '🤔', '😄', '😍', '😭', '👎', '✅'];

  // 点击某个表情（toggle）：服务端同人同表情点两次 = 取消
  function toggleReaction(mid, emoji) {
    if (!mid || !emoji) return;
    socket.emit('message_reaction', { room: state.currentRoom, msgId: mid, emoji });
  }

  // 表情选择小面板（消息级的常用表情板；同一时刻只开一个）
  let activePicker = null;
  function closeReactionPicker() {
    if (activePicker) { activePicker.remove(); activePicker = null; }
  }
  function onPickerOutside() { closeReactionPicker(); }
  function openReactionPicker(anchor, data) {
    closeReactionPicker();
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    for (const e of REACTION_QUICK) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.title = e;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeReactionPicker();
        toggleReaction(data.id, e);
      });
      picker.appendChild(b);
    }
    document.body.appendChild(picker);
    activePicker = picker;
    const r = anchor.getBoundingClientRect();
    picker.style.left = Math.max(4, Math.min(r.left, window.innerWidth - picker.offsetWidth - 8)) + 'px';
    picker.style.top = (r.top - picker.offsetHeight - 6) + 'px';
    setTimeout(() => {
      document.addEventListener('click', onPickerOutside, { once: true });
    }, 0);
  }

  // 在消息 DOM 上渲染/更新回应条（含添加按钮）
  function renderReactionBar(div, data) {
    if (!div) return;
    let bar = div.querySelector('.reaction-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'reaction-bar';
      bar.dataset.role = 'reactions';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'reaction-add-btn';
      add.title = '添加回应';
      add.textContent = '🙂';
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        openReactionPicker(add, data);
      });
      bar.appendChild(add);
      const footer = div.querySelector('.msg-footer');
      if (footer) footer.insertBefore(bar, footer.firstChild);
    }
    const addBtn = bar.querySelector('.reaction-add-btn');
    bar.querySelectorAll('.reaction-chip').forEach((c) => c.remove());
    const chips = Array.isArray(data.reactions) ? data.reactions : [];
    for (const r of chips) {
      // mine 由 clientIds 本地判定（服务端广播里的 mine 是操作者视角，不可直接信）
      const mine = (r.clientIds || []).includes(state.myClientId);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction-chip' + (mine ? ' mine' : '');
      chip.dataset.emoji = r.emoji;
      chip.title = (r.names || []).join('、') || r.emoji;
      chip.innerHTML = `${escapeHtml(r.emoji)} <b>${r.count}</b>`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleReaction(data.id, r.emoji);
      });
      if (addBtn) bar.insertBefore(chip, addBtn);
    }
  }

  // 实时更新某条消息的回应条
  function updateReactionBar(mid, reactions) {
    if (!mid) return;
    const el = chatArea.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
    if (!el) return;
    const stored = state.msgStore.get(mid);
    if (stored) { stored.reactions = reactions; state.msgStore.set(mid, stored); }
    renderReactionBar(el, Object.assign({}, stored || {}, { id: mid, reactions }));
  }

  socket.on('message_reaction', (data) => {
    if (!data || (data.room || 'main') !== state.currentRoom) return;
    updateReactionBar(data.msgId, data.reactions);
  });

  // 消息页脚：回应条（左）+ 已读标记（右，自己的消息）
  function appendMsgFooter(div, data) {
    const isSelf = C.isOwnMessage(data);
    const footer = document.createElement('div');
    footer.className = 'msg-footer';
    div.appendChild(footer);
    if (isSelf) {
      const tag = document.createElement('span');
      tag.className = 'msg-read';
      tag.dataset.role = 'read';
      footer.appendChild(tag);
      // 历史装饰已带 readBy（会话内已读）→ 并入本地缓存
      if (Array.isArray(data.readBy)) {
        let readers = state.msgReadBy.get(data.id);
        if (!readers) { readers = new Map(); state.msgReadBy.set(data.id, readers); }
        for (const r of data.readBy) if (r && r.clientId && !readers.has(r.clientId)) readers.set(r.clientId, r.nickname || '');
      }
      updateReadIndicator(data.id);
    }
    renderReactionBar(div, data);
  }

  Object.assign(C, {
    appendMsgFooter, emitRead, markHistoryRead,
    updateReadIndicator, updateReactionBar, toggleReaction
  });
  Object.assign(app, {
    initHistoryState, markHistoryRead, emitRead,
    updateReactionBar, toggleReaction, updateReadIndicator
  });
})();
