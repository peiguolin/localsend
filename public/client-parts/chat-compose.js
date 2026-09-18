/* chat 发送与操作片：收消息编排、机器人流式气泡、发送、右键菜单（引用/复制/翻译/置顶/撤回）。
 * 内部依赖经 C（app._chat）：渲染函数、isOwnMessage、emitRead 等；对外仍由 chat.js 门面统一导出。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const C = app._chat;
  const socket = app.socket;
  const state = app.state;
  const { escapeHtml, mostlyCJK } = app.utils;

  const chatArea = document.getElementById('chatArea');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const quotePreview = document.getElementById('quotePreview');

  // ---------- 接收聊天消息 ----------
  socket.on('chat_message', (data) => {
    if (data.id) state.msgStore.set(data.id, data);
    const msgRoom = data.room || 'main';
    if (msgRoom !== state.currentRoom) {
      // 不是当前房间 → 只加该房间未读
      state.roomUnread.set(msgRoom, (state.roomUnread.get(msgRoom) || 0) + 1);
      app.updateRoomUnreadBadge(msgRoom);
      return;
    }
    if (data.type === 'image') C.renderImageMsg(data);
    else if (data.type === 'file') C.renderFileMsg(data);
    else C.renderTextMsg(data);
    // 自己发的消息始终滚到最新（自己输入后自动到底部）
    if (app.isOwnMessage(data)) app.scrollToBottom(true);
    app.handleIncomingMessage(data);
    // 正在看当前房间且停在底部 → 即时标记已读（自己发的也会上报，服务端会跳过发送者）
    if (app.isNearBottom && app.isNearBottom()) C.emitRead(msgRoom, data.timestamp);
  });

  // ---------- 机器人流式回复（打字机）----------
  const botStreams = new Map();

  socket.on('bot_start', (data) => {
    if (!data || (data.room || 'main') !== state.currentRoom) return;
    if (botStreams.has(data.tempId)) return;
    const div = document.createElement('div');
    div.className = 'msg other bot streaming';
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-bot-badge">🤖</span>
        <span class="msg-nick">${escapeHtml(data.nickname || '机器人')}</span>
      </div>
      <div class="msg-bubble"></div>
    `;
    const bubble = div.querySelector('.msg-bubble');
    bubble.textContent = '';
    app.appendMsg(div);
    botStreams.set(data.tempId, { div, bubble, full: '' });
    app.scrollToBottom(false);
  });

  socket.on('bot_delta', (data) => {
    const s = botStreams.get(data && data.tempId);
    if (!s) return;
    s.full = typeof data.full === 'string' ? data.full : (s.full + (data.piece || ''));
    s.bubble.textContent = s.full;
    // 用户停在底部附近时跟随滚动，翻看历史时不打断
    if (app.isNearBottom()) chatArea.scrollTop = chatArea.scrollHeight;
  });

  socket.on('bot_done', (data) => {
    const s = botStreams.get(data && data.tempId);
    if (s) { s.div.remove(); botStreams.delete(data.tempId); }
    // 正式 chat_message 紧随其后到达，走常规渲染（入库态、高亮、引用等）
  });

  socket.on('bot_error', (data) => {
    const s = botStreams.get(data && data.tempId);
    if (s) {
      s.div.classList.remove('streaming');
      s.bubble.textContent = `🤖 ${(data && data.error) || '生成失败'}`;
      s.bubble.classList.add('bot-error');
      botStreams.delete(data.tempId);
      setTimeout(() => s.div.remove(), 6000);
    }
  });

  // ---------- 发送聊天消息 ----------
  function sendMessage() {
    app.closeEmojiPanel();
    const text = msgInput.value.trim();
    // 托盘有附件 → 走上传通道（文字作为配文，可空），由服务端回 chat_message 渲染
    if (app.hasPendingAttachment && app.hasPendingAttachment()) {
      app.sendAttachment(text);
      msgInput.value = '';
      clearQuote();
      app.closeAutocomplete();
      msgInput.focus();
      app.scrollToBottom(true);
      app.resetPill();
      return;
    }
    if (!text) return;
    socket.emit('chat_message', { text, quoteId: state.quoting ? state.quoting.id : undefined, clientId: state.myClientId, room: state.currentRoom });
    msgInput.value = '';
    clearQuote();
    app.closeAutocomplete();
    msgInput.focus();
    app.scrollToBottom(true);
    app.resetPill();
  }

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    // @ 补全打开时优先处理导航键（acMove/acSelect/closeAutocomplete 来自 autocomplete 分片）
    if (state.acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); app.acMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); app.acMove(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); app.acSelect(); return; }
      if (e.key === 'Escape') { app.closeAutocomplete(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ---------- 右键菜单（引用回复 / 复制文本 / 撤回 / 置顶 / 翻译；state.ctxMenu 见 state.js） ----------
  function closeCtxMenu() {
    if (state.ctxMenu) {
      state.ctxMenu.remove();
      state.ctxMenu = null;
    }
  }
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });

  chatArea.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.msg[data-mid]');
    if (!msgEl) return;
    const data = state.msgStore.get(msgEl.dataset.mid);
    if (!data || data.recalled) return;
    e.preventDefault();
    openCtxMenu(e.clientX, e.clientY, data);
  });

  // 移动端长按消息呼出同一菜单（手机上无右键）
  chatArea.addEventListener('touchstart', (e) => {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const msgEl = e.target.closest('.msg[data-mid]');
    if (!msgEl) return;
    const data = state.msgStore.get(msgEl.dataset.mid);
    if (!data || data.recalled) return;
    const tx = touch.clientX, ty = touch.clientY;
    state.longPressFired = false;
    state.longPressTimer = setTimeout(() => {
      state.longPressFired = true;
      e.preventDefault();
      openCtxMenu(tx, ty, data);
    }, 500);
  }, { passive: false });
  chatArea.addEventListener('touchend', () => { clearTimeout(state.longPressTimer); });
  chatArea.addEventListener('touchmove', () => { clearTimeout(state.longPressTimer); });
  chatArea.addEventListener('touchcancel', () => { clearTimeout(state.longPressTimer); });
  // 长按后拦截后续 click，避免菜单刚弹出又被 document click 关掉
  chatArea.addEventListener('click', (e) => {
    if (state.longPressFired) { state.longPressFired = false; e.stopPropagation(); }
  }, true);

  // 当前用户能否管理本房间（置顶/公告）：宿主机任意房间；群聊房另加房主本人；main 仅宿主机
  function canManageRoom() {
    if (state.isLocalHost) return true;
    if (state.currentRoom === 'main') return false;
    const room = state.myRooms.find((r) => r.id === state.currentRoom);
    return !!(room && room.ownerClientId === state.myClientId);
  }

  function pinMessage(id) {
    socket.emit('room_pin_add', { room: state.currentRoom, msgId: id }, (res) => {
      if (!res || !res.ok) app.setHint((res && res.error) || '置顶失败', 'error');
    });
  }
  function unpinMessage(id) {
    socket.emit('room_pin_remove', { room: state.currentRoom, msgId: id }, (res) => {
      if (!res || !res.ok) app.setHint((res && res.error) || '取消置顶失败', 'error');
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => app.setHint('已复制', 'success'),
        () => app.setHint('复制失败', 'error')
      );
    } else {
      app.setHint('复制失败', 'error');
    }
  }

  function openCtxMenu(x, y, data) {
    closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const items = [{ label: '引用回复', fn: () => startQuote(data) }];
    if (data.type === 'text') {
      items.push({ label: '复制文本', fn: () => copyText(data.text) });
      if (state.translationAvailable && !mostlyCJK(data.text)) {
        items.push({ label: '翻译成中文', fn: () => translateMessage(data) });
      }
    }
    if (canManageRoom()) {
      const pinned = C.isPinnedMsg(data.id);
      items.push({ label: pinned ? '取消置顶' : '置顶消息', fn: () => (pinned ? unpinMessage(data.id) : pinMessage(data.id)) });
    }
    if (C.isOwnMessage(data) && Date.now() - data.timestamp < 120000) {
      items.push({ label: '撤回', danger: true, fn: () => recallMessage(data.id) });
    }
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.textContent = it.label;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        it.fn();
        closeCtxMenu();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    state.ctxMenu = menu;
  }

  // 代码块复制按钮（事件委托，后续消息同样生效）
  chatArea.addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy');
    if (!btn) return;
    const code = btn.closest('.code-block').querySelector('code');
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = '已复制 ✓';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      }, () => app.setHint('复制失败', 'error'));
    }
  });

  // ---------- 消息翻译（右键翻译成中文；译文块附在气泡下方，不改原消息） ----------
  fetch('/api/translate/status')
    .then((r) => r.json())
    .then((j) => { state.translationAvailable = !!(j && j.available); })
    .catch(() => { state.translationAvailable = false; });

  async function translateMessage(data) {
    if (!data.id) return;
    const msgEl = chatArea.querySelector(`[data-mid="${CSS.escape(data.id)}"]`);
    if (!msgEl) return;
    // 已有译文块 → 收起/展开切换
    let block = msgEl.querySelector('.translate-block');
    if (block) {
      block.classList.toggle('collapsed');
      return;
    }
    block = document.createElement('div');
    block.className = 'translate-block';
    block.title = '再次从右键菜单选择「翻译成中文」可收起/展开';
    block.innerHTML = '<span class="translate-label">译文</span><span class="translate-text">翻译中…</span>';
    const bubble = msgEl.querySelector('.msg-bubble');
    (bubble || msgEl).insertAdjacentElement('afterend', block);
    // 会话内已有结果直接复用
    if (data.translationZh) {
      block.querySelector('.translate-text').textContent = data.translationZh;
      return;
    }
    try {
      const r = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: data.text, target: 'zh' })
      });
      const j = await r.json();
      if (j && j.ok) {
        data.translationZh = j.translation;
        block.querySelector('.translate-text').textContent = j.translation;
      } else {
        block.querySelector('.translate-text').textContent = (j && j.error) || '翻译失败';
        block.classList.add('error');
      }
    } catch (_) {
      block.querySelector('.translate-text').textContent = '翻译服务不可用';
      block.classList.add('error');
    }
  }

  // ---------- 引用回复（输入栏预览条；state.quoting 见 state.js） ----------
  function startQuote(data) {
    let text = data.text || '';
    if (data.type === 'file') text = `[文件] ${data.fileName || ''}`;
    else if (data.type === 'image') text = `[图片] ${data.fileName || ''}`;
    text = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    state.quoting = { id: data.id, nickname: data.nickname, text };
    quotePreview.innerHTML = `
      <span class="quote-preview-label">回复 ${escapeHtml(state.quoting.nickname)}:</span>
      <span class="quote-preview-text">${escapeHtml(state.quoting.text)}</span>
      <button class="quote-preview-x" type="button" title="取消引用">×</button>
    `;
    quotePreview.hidden = false;
    quotePreview.querySelector('.quote-preview-x').addEventListener('click', clearQuote);
    msgInput.focus();
  }

  function clearQuote() {
    state.quoting = null;
    quotePreview.hidden = true;
    quotePreview.innerHTML = '';
  }

  // ---------- 撤回消息 ----------
  function recallMessage(id) {
    socket.emit('chat_recall', { id, clientId: state.myClientId }, (res) => {
      if (!res || !res.ok) app.setHint((res && res.error) || '撤回失败', 'error');
    });
  }

  socket.on('chat_recall', (data) => {
    if (!data) return;
    const rec = state.msgStore.get(data.id);
    if (rec) rec.recalled = true;
    if (state.quoting && state.quoting.id === data.id) clearQuote();
    const el = chatArea.querySelector(`[data-mid="${CSS.escape(data.id)}"]`);
    if (el) {
      const isSelf = C.isOwnMessage({ nickname: data.nickname, clientId: data.clientId });
      el.className = 'msg system';
      el.removeAttribute('data-mid');
      el.innerHTML = `<div class="msg-bubble">${escapeHtml(isSelf ? '你' : data.nickname)} 撤回了一条消息</div>`;
    }
  });

  Object.assign(app, {
    clearQuote, canManageRoom, pinMessage, unpinMessage
  });
})();
