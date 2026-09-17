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

  // ---------- 历史分页（往上滚懒加载） ----------
  let historyPrepend = false; // 为 true 时 renderXMsg 改为前插（加载更早消息用）

  // ---------- 消息时间分隔线（今天 / 昨天 / 日期） ----------
  function dayKey(ts) {
    const d = new Date(Number(ts) || 0);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayLabel(ts, nowTs) {
    const d = new Date(Number(ts) || 0);
    const n = new Date(Number(nowTs) || Date.now());
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, n)) return '今天';
    const y = new Date(n); y.setDate(n.getDate() - 1);
    if (same(d, y)) return '昨天';
    const fmt = `${d.getMonth() + 1}月${d.getDate()}日`;
    return d.getFullYear() === n.getFullYear() ? fmt : `${d.getFullYear()}年${fmt}`;
  }
  function makeDayDivider(ts) {
    const div = document.createElement('div');
    div.className = 'msg-day-divider';
    div.innerHTML = `<span>${escapeHtml(dayLabel(ts))}</span>`;
    return div;
  }
  // 在容器里找第一条/最后一条「有时间的消息」（跳过系统消息/分隔线/占位）；兼容真实 DOM 与冒烟桩数组
  function siblingMsgWithTs(container, fromEnd) {
    const kids = container.children;
    for (let i = fromEnd ? kids.length - 1 : 0; fromEnd ? i >= 0 : i < kids.length; fromEnd ? i-- : i++) {
      const el = kids[i];
      if (el && el.classList && el.classList.contains('msg') && Number(el.dataset && el.dataset.ts)) return el;
    }
    return null;
  }

  function insertMsgNode(div) {
    const ts = Number(div.dataset && div.dataset.ts) || 0;
    if (ts) {
      if (historyPrepend) {
        // 前插更早消息：与当前最上面一条（更晚的）跨天 → 分隔线插到更早消息之上
        const first = siblingMsgWithTs(chatArea, false);
        if (first && Number(first.dataset.ts) && dayKey(ts) !== dayKey(Number(first.dataset.ts))) {
          app.prependMsg(makeDayDivider(ts));
        }
      } else {
        // 追加新消息：与当前最后一条（更早的）跨天 → 分隔线插到新消息之前
        const last = siblingMsgWithTs(chatArea, true);
        if (last && Number(last.dataset.ts) && dayKey(ts) !== dayKey(Number(last.dataset.ts))) {
          app.appendMsg(makeDayDivider(ts));
        }
      }
    }
    if (historyPrepend) app.prependMsg(div);
    else app.appendMsg(div);
  }

  // 初始化/重置分页状态：传 history=初始历史（升序）；不传则重置（切房时先清，防串房）
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
        historyPrepend = true;
        // 逆序前插，保持时间升序（每次插到最前，最旧自然落在顶部）
        for (let i = res.history.length - 1; i >= 0; i--) {
          const m = res.history[i];
          if (!m || m.recalled) continue;
          if (m.type === 'image') renderImageMsg(m);
          else if (m.type === 'file') renderFileMsg(m);
          else renderTextMsg(m);
        }
        historyPrepend = false;
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

  // ---------- 消息渲染 ----------
  function renderSystemMsg(data) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `
      <div class="msg-bubble">${escapeHtml(data.text || '')}</div>
    `;
    insertMsgNode(div);
  }

  // ---------- 消息内容渲染：```代码块 / `行内代码` / @提及（全程先转义再拼接，防 XSS） ----------
  function highlightMentions(html, mentions, mentionAll) {
    const nicks = (mentions || []).slice().sort((a, b) => b.length - a.length);
    for (const nick of nicks) {
      const target = '@' + escapeHtml(nick);
      const cls = nick === state.myNickname ? 'mention mention-me' : 'mention';
      html = html.split(target).join(`<span class="${cls}">${target}</span>`);
    }
    if (mentionAll) {
      // @全员：@所有人 / @all / @everyone（大小写不敏感；与服务端判定同边界规则）
      html = html.replace(/@(?:所有人|everyone)(?![\w一-龥])|@all\b/ig, (m) => `<span class="mention mention-all">${m}</span>`);
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
    const mentionAll = !!(data && (data.mentionAll === true || app.utils.hasMentionAll(data.text)));
    return segs.map((seg) => {
      if (seg.t === 'code') {
        return `<div class="code-block"><div class="code-bar"><span class="code-lang">${escapeHtml(seg.lang || 'auto')}</span><button class="code-copy" type="button">复制</button></div><pre><code data-lang="${escapeHtml(seg.lang)}">${escapeHtml(seg.c)}</code></pre></div>`;
      }
      let html = escapeHtml(seg.c).replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
      html = highlightMentions(html, data && data.mentions, mentionAll);
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

  // ---------- 置顶标记（state.pins: room -> [{msgId, msg, ...}]，见 state.js） ----------
  function isPinnedMsg(id) {
    const pins = state.pins && state.pins.get(state.currentRoom);
    return !!(id && pins && pins.some((p) => p.msgId === id));
  }
  function pinBadgeHTML(data) {
    return isPinnedMsg(data && data.id) ? '<span class="msg-pin-badge" title="已置顶">📌</span>' : '';
  }
  // 给已渲染的消息 DOM 加/去置顶角标（进房渲染置顶条时批量调用）
  function markMessagePinned(mid, on) {
    if (!mid) return;
    const el = chatArea.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
    if (!el) return;
    const header = el.querySelector('.msg-header');
    if (!header) return;
    if (on) {
      if (header.querySelector('.msg-pin-badge')) return;
      const b = document.createElement('span');
      b.className = 'msg-pin-badge';
      b.title = '已置顶';
      b.textContent = '📌';
      header.insertBefore(b, header.firstChild);
    } else {
      const b = header.querySelector('.msg-pin-badge');
      if (b) b.remove();
    }
  }

  // ---------- 表情回应（实时广播；reactions 见服务端装饰/reaction 事件） ----------
  // 常用表情快捷板（点击消息上的 🙂 弹出）
  const REACTION_QUICK = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👏', '👍🏻', '🙏', '🤔', '😄', '😍', '😭', '👎', '✅'];

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
    // 刷新既有 chips（保留添加按钮；按钮在已存在/新建两种情况下都从 bar 内查，避免作用域问题）
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
    function onPickerOutside() { closeReactionPicker(); }
  }

  socket.on('message_reaction', (data) => {
    if (!data || (data.room || 'main') !== state.currentRoom) return;
    updateReactionBar(data.msgId, data.reactions);
  });

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

  // 消息页脚：回应条（左）+ 已读标记（右，自己的消息）
  function appendMsgFooter(div, data) {
    const isSelf = isOwnMessage(data);
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

  function renderTextMsg(data) {
    const isSelf = isOwnMessage(data);
    const mentionedMe = !isSelf && (app.utils.hasMentionAll(data.text) || (data.mentions || []).includes(state.myNickname));
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other') + (mentionedMe ? ' mentioned' : '') + (data.isBot ? ' bot' : '');
    if (data.id) div.dataset.mid = data.id;
    if (data.timestamp) div.dataset.ts = data.timestamp;
    div.innerHTML = `
      <div class="msg-header">
        ${data.isBot ? '<span class="msg-bot-badge">🤖</span>' : ''}
        ${pinBadgeHTML(data)}
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      ${renderQuoteBlock(data.quote)}
      <div class="msg-bubble">${renderContentHTML(data.text, data)}</div>
    `;
    applyCodeHighlight(div);
    const q = div.querySelector('.msg-quote');
    if (q) q.addEventListener('click', () => scrollToMessage(q.dataset.qid));
    appendMsgFooter(div, data);
    insertMsgNode(div);
  }

  // 图片/文件的文字说明（caption）：复用消息内容渲染（@高亮/代码），渲染成单独的小气泡
  function captionHTML(data) {
    if (!data || !data.text) return '';
    return `<div class="msg-caption">${renderContentHTML(data.text, data)}</div>`;
  }

  // 普通文件卡片气泡
  function fileBubbleHTML(data) {
    return `
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
      </div>`;
  }

  // 语音消息气泡：内嵌播放器
  function audioBubbleHTML(data) {
    return `
      <div class="msg-bubble audio-bubble">
        <audio class="msg-audio" controls preload="metadata" src="${escapeHtml(data.downloadUrl)}" title="${escapeHtml(data.fileName)}"></audio>
        <div class="audio-meta">🎙️ 语音消息 · ${fmtSize(data.size)}</div>
      </div>`;
  }

  function renderFileMsg(data) {
    const isSelf = isOwnMessage(data);
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    if (data.id) div.dataset.mid = data.id;
    if (data.timestamp) div.dataset.ts = data.timestamp;
    div.innerHTML = `
      <div class="msg-header">
        ${pinBadgeHTML(data)}
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      ${data.audio ? audioBubbleHTML(data) : fileBubbleHTML(data)}
      ${captionHTML(data)}
    `;
    applyCodeHighlight(div);
    appendMsgFooter(div, data);
    insertMsgNode(div);
  }

  function renderImageMsg(data) {
    const isSelf = isOwnMessage(data);
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    if (data.id) div.dataset.mid = data.id;
    if (data.timestamp) div.dataset.ts = data.timestamp;
    div.innerHTML = `
      <div class="msg-header">
        ${pinBadgeHTML(data)}
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      <div class="msg-bubble image-bubble">
        <img class="msg-image" src="${escapeHtml(data.imageUrl)}" alt="${escapeHtml(data.fileName)}" title="${escapeHtml(data.fileName)}" loading="lazy">
      </div>
      ${captionHTML(data)}
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
    applyCodeHighlight(div);
    appendMsgFooter(div, data);
    insertMsgNode(div);
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
    // 自己发的消息始终滚到最新（自己输入后自动到底部）
    if (app.isOwnMessage(data)) app.scrollToBottom(true);
    app.handleIncomingMessage(data);
    // 正在看当前房间且停在底部 → 即时标记已读（自己发的也会上报，服务端会跳过发送者）
    if (app.isNearBottom && app.isNearBottom()) emitRead(msgRoom, data.timestamp);
  });

  // ---------- 机器人流式回复（打字机）----------
  // tempId -> { bubble, full }；bot_start 建临时气泡，bot_delta 追加，
  // bot_done 移除临时气泡（紧接着正式 chat_message 渲染最终版），bot_error 显示错误
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
      const pinned = isPinnedMsg(data.id);
      items.push({ label: pinned ? '取消置顶' : '置顶消息', fn: () => (pinned ? unpinMessage(data.id) : pinMessage(data.id)) });
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

  // 暴露给其他分片（rooms 切房历史、壳 welcome 编排 / 未读归属判定 / 历史分页初始化等）
  Object.assign(app, {
    renderSystemMsg,
    renderTextMsg,
    renderFileMsg,
    renderImageMsg,
    clearQuote,
    isOwnMessage,
    initHistoryState,
    isPinnedMsg,
    markMessagePinned,
    canManageRoom,
    pinMessage,
    unpinMessage,
    markHistoryRead,
    emitRead,
    updateReactionBar,
    toggleReaction,
    updateReadIndicator
  });
})();
