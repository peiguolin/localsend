/* chat 渲染片：消息 DOM / 内容高亮(@、代码) / 引用块 / 置顶角标 / 灯箱 / 时间分隔线。
 * 跨片协作经内部总线 C（app._chat）：插入走 C.insertMsgNode，页脚(回应+已读)走 C.appendMsgFooter。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const C = app._chat;
  const state = app.state;
  const { escapeHtml, fmtTime, fmtSize } = app.utils;

  const chatArea = document.getElementById('chatArea');

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
      if (C.historyPrepend) {
        const first = siblingMsgWithTs(chatArea, false);
        if (first && Number(first.dataset.ts) && dayKey(ts) !== dayKey(Number(first.dataset.ts))) {
          app.prependMsg(makeDayDivider(ts));
        }
      } else {
        const last = siblingMsgWithTs(chatArea, true);
        if (last && Number(last.dataset.ts) && dayKey(ts) !== dayKey(Number(last.dataset.ts))) {
          app.appendMsg(makeDayDivider(ts));
        }
      }
    }
    if (C.historyPrepend) app.prependMsg(div);
    else app.appendMsg(div);
  }

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
    C.appendMsgFooter(div, data);
    insertMsgNode(div);
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
    C.appendMsgFooter(div, data);
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
    C.appendMsgFooter(div, data);
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

  // 暴露到内部总线（供历史/发送片）与对外 app（供 rooms/壳 welcome 编排）
  Object.assign(C, {
    insertMsgNode, renderSystemMsg, renderTextMsg, renderFileMsg, renderImageMsg,
    renderContentHTML, scrollToMessage, isOwnMessage,
    isPinnedMsg, markMessagePinned
  });
  Object.assign(app, {
    renderSystemMsg, renderTextMsg, renderFileMsg, renderImageMsg,
    isOwnMessage, isPinnedMsg, markMessagePinned
  });
})();
