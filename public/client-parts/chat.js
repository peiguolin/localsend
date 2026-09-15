/* 消息分片：渲染 / 发送 / 引用回复 / 撤回 / 翻译 / 右键菜单 / 灯箱。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之后加载。
 * 跨模块依赖：壳的 appendMsg/scrollToBottom/hideUnreadPill/handleIncomingMessage/setHint，
 * rooms 的 updateRoomUnreadBadge，emoji 的 closeEmojiPanel，ac 的 closeAutocomplete —— 均经 app.* 事件期调用。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const socket = app.socket;
  const state = app.state;
  const { escapeHtml, fmtTime, fmtSize, mostlyCJK } = app.utils;

  // ---------- DOM 引用 ----------
  const chatArea = document.getElementById('chatArea');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const quotePreview = document.getElementById('quotePreview');

  // ---------- 消息渲染 ----------
  function renderSystemMsg(data) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `
      <div class="msg-bubble">${escapeHtml(data.text || '')}</div>
    `;
    app.appendMsg(div);
  }

  // ---------- 消息内容渲染：```代码块 / `行内代码` / @提及（全程先转义再拼接，防 XSS） ----------
  function highlightMentions(html, mentions) {
    const nicks = (mentions || []).slice().sort((a, b) => b.length - a.length);
    for (const nick of nicks) {
      const target = '@' + escapeHtml(nick);
      const cls = nick === state.myNickname ? 'mention mention-me' : 'mention';
      html = html.split(target).join(`<span class="${cls}">${target}</span>`);
    }
    return html;
  }

  function renderContentHTML(text, data) {
    const segs = [];
    const fenceRe = /```(\w{0,20})\n?([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fenceRe.exec(text))) {
      if (m.index > last) segs.push({ t: 'text', c: text.slice(last, m.index) });
      segs.push({ t: 'code', lang: (m[1] || '').toLowerCase(), c: m[2].replace(/\n$/, '') });
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ t: 'text', c: text.slice(last) });
    return segs.map((seg) => {
      if (seg.t === 'code') {
        return `<div class="code-block"><div class="code-bar"><span class="code-lang">${escapeHtml(seg.lang || 'auto')}</span><button class="code-copy" type="button">复制</button></div><pre><code data-lang="${escapeHtml(seg.lang)}">${escapeHtml(seg.c)}</code></pre></div>`;
      }
      let html = escapeHtml(seg.c).replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
      html = highlightMentions(html, data && data.mentions);
      return html;
    }).join('');
  }

  // 代码块语法高亮（hljs 输出自带转义，可安全 innerHTML）
  function applyCodeHighlight(container) {
    if (!window.hljs) return;
    container.querySelectorAll('.code-block code').forEach((el) => {
      const lang = el.dataset.lang;
      const raw = el.textContent;
      try {
        if (lang && window.hljs.getLanguage(lang)) {
          el.innerHTML = window.hljs.highlight(raw, { language: lang }).value;
        } else {
          const r = window.hljs.highlightAuto(raw);
          el.innerHTML = r.value;
          const label = el.closest('.code-block').querySelector('.code-lang');
          if (label && r.language) label.textContent = r.language;
        }
      } catch (_) { /* 高亮失败保持纯文本 */ }
    });
  }

  function renderQuoteBlock(quote) {
    if (!quote) return '';
    return `<div class="msg-quote" data-qid="${escapeHtml(quote.id)}" title="点击定位原消息">
      <span class="msg-quote-nick">${escapeHtml(quote.nickname)}</span>
      <span class="msg-quote-text">${escapeHtml(quote.text)}</span>
    </div>`;
  }

  // 点击引用块 → 滚动定位原消息并闪烁
  function scrollToMessage(mid) {
    const el = chatArea.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
    if (!el) {
      app.setHint('原消息不在当前会话中', 'error');
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  // 归属判断：优先用持久 clientId（重进/换昵称也正确）；旧数据无 clientId 时退回昵称匹配
  function isOwnMessage(data) {
    if (data && data.clientId) return data.clientId === state.myClientId;
    return data && data.nickname === state.myNickname;
  }

  function renderTextMsg(data) {
    const isSelf = isOwnMessage(data);
    const mentionedMe = !isSelf && (data.mentions || []).includes(state.myNickname);
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other') + (mentionedMe ? ' mentioned' : '') + (data.isBot ? ' bot' : '');
    if (data.id) div.dataset.mid = data.id;
    div.innerHTML = `
      <div class="msg-header">
        ${data.isBot ? '<span class="msg-bot-badge">🤖</span>' : ''}
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      ${renderQuoteBlock(data.quote)}
      <div class="msg-bubble">${renderContentHTML(data.text, data)}</div>
    `;
    applyCodeHighlight(div);
    const q = div.querySelector('.msg-quote');
    if (q) q.addEventListener('click', () => scrollToMessage(q.dataset.qid));
    app.appendMsg(div);
  }

  function renderFileMsg(data) {
    const isSelf = isOwnMessage(data);
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    if (data.id) div.dataset.mid = data.id;
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      <div class="msg-bubble file-bubble">
        <div class="file-card">
          <div class="file-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
          </div>
          <div class="file-info">
            <div class="file-name" title="${escapeHtml(data.fileName)}">${escapeHtml(data.fileName)}</div>
            <div class="file-size">${fmtSize(data.size)}</div>
          </div>
          <a class="download-btn" href="${escapeHtml(data.downloadUrl)}" download>下载</a>
        </div>
      </div>
    `;
    app.appendMsg(div);
  }

  function renderImageMsg(data) {
    const isSelf = isOwnMessage(data);
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    if (data.id) div.dataset.mid = data.id;
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      <div class="msg-bubble image-bubble">
        <img class="msg-image" src="${escapeHtml(data.imageUrl)}" alt="${escapeHtml(data.fileName)}" title="${escapeHtml(data.fileName)}" loading="lazy">
      </div>
    `;
    const img = div.querySelector('.msg-image');
    img.addEventListener('click', () => openLightbox(data));
    img.addEventListener('error', () => {
      const bubble = div.querySelector('.image-bubble');
      bubble.innerHTML = `
        <div class="image-error-tip">图片加载失败</div>
        <a class="download-btn" href="${escapeHtml(data.downloadUrl)}" download>下载原图</a>
      `;
    });
    app.appendMsg(div);
  }

  // ---------- 图片灯箱（点击放大预览） ----------
  function openLightbox(data) {
    let overlay = document.getElementById('lightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'lightbox';
      overlay.className = 'lightbox';
      overlay.innerHTML = `
        <div class="lightbox-backdrop"></div>
        <div class="lightbox-content">
          <img class="lightbox-img" alt="">
          <div class="lightbox-bar">
            <span class="lightbox-name"></span>
            <a class="lightbox-download" download>下载原图</a>
            <button class="lightbox-close" type="button">关闭</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay ||
            e.target.classList.contains('lightbox-backdrop') ||
            e.target.classList.contains('lightbox-close')) {
          overlay.classList.remove('show');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('show')) {
          overlay.classList.remove('show');
        }
      });
    }
    overlay.querySelector('.lightbox-img').src = data.imageUrl;
    overlay.querySelector('.lightbox-img').alt = data.fileName || '';
    overlay.querySelector('.lightbox-name').textContent =
      data.fileName ? `${data.fileName}（${fmtSize(data.size)}）` : fmtSize(data.size);
    overlay.querySelector('.lightbox-download').href = data.downloadUrl;
    overlay.classList.add('show');
  }

  // ---------- 接收聊天消息 ----------
  socket.on('chat_message', (data) => {
    if (data.id) state.msgStore.set(data.id, data);
    const msgRoom = data.room || 'main';
    if (msgRoom !== state.currentRoom) {
      // 不是当前房间 → 只加该房间未读（页面有焦点且是当前房间才清，其它房间先计数）
      state.roomUnread.set(msgRoom, (state.roomUnread.get(msgRoom) || 0) + 1);
      app.updateRoomUnreadBadge(msgRoom);
      return;
    }
    if (data.type === 'image') {
      renderImageMsg(data);
    } else if (data.type === 'file') {
      renderFileMsg(data);
    } else {
      renderTextMsg(data);
    }
    app.handleIncomingMessage(data);
  });

  // ---------- 发送聊天消息 ----------
  function sendMessage() {
    app.closeEmojiPanel();
    const text = msgInput.value.trim();
    if (!text) return;
    socket.emit('chat_message', { text, quoteId: state.quoting ? state.quoting.id : undefined, clientId: state.myClientId, room: state.currentRoom });
    msgInput.value = '';
    clearQuote();
    app.closeAutocomplete();
    msgInput.focus();
    app.scrollToBottom(true);
    app.hideUnreadPill();
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

  // ---------- 右键菜单（引用回复 / 复制文本 / 撤回；state.ctxMenu 见 state.js） ----------
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
  // state.longPressTimer / state.longPressFired 见 state.js
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
    if (isOwnMessage(data) && Date.now() - data.timestamp < 120000) {
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

  // ---------- 消息翻译（右键翻译成中文；译文块附在气泡下方，不改原消息；
  // state.translationAvailable 见 state.js） ----------
  fetch('/api/translate/status')
    .then((r) => r.json())
    .then((j) => { state.translationAvailable = !!(j && j.available); })
    .catch(() => { state.translationAvailable = false; });
  // mostlyCJK 来自 client-parts/util.js（翻译入口跳过已中消息用）

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
      const isSelf = isOwnMessage({ nickname: data.nickname, clientId: data.clientId });
      el.className = 'msg system';
      el.removeAttribute('data-mid');
      el.innerHTML = `<div class="msg-bubble">${escapeHtml(isSelf ? '你' : data.nickname)} 撤回了一条消息</div>`;
    }
  });

  // 暴露给其他分片（rooms 切房历史、壳 welcome 编排 / 未读归属判定等）
  Object.assign(app, {
    renderSystemMsg,
    renderTextMsg,
    renderFileMsg,
    renderImageMsg,
    clearQuote,
    isOwnMessage
  });
})();
