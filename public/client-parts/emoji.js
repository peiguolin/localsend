/* 表情分片：表情选择器（分类 / 搜索 / 最近使用，分批渲染）。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之后加载。
 * 依赖：state（emojiActiveCat / emojiSearchQ）与 msgInput DOM。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const state = app.state;

  // ---------- DOM 引用 ----------
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPanel = document.getElementById('emojiPanel');
  const emojiSearch = document.getElementById('emojiSearch');
  const emojiTabs = document.getElementById('emojiTabs');
  const emojiGrid = document.getElementById('emojiGrid');
  const msgInput = document.getElementById('msgInput');

  const EMOJI = window.EMOJI_DATA || { categories: [], emojis: {} };
  const EMOJI_CAT_META = {
    people: ['😀', '表情与人物'],
    nature: ['🐵', '动物自然'],
    foods: ['🍔', '食物'],
    activity: ['⚽', '活动'],
    places: ['🚗', '地点'],
    objects: ['💡', '物品'],
    symbols: ['❤️', '符号'],
    flags: ['🚩', '旗帜']
  };
  const EMOJI_RECENT_KEY = 'localsend-emoji-recent';
  // state.emojiActiveCat / state.emojiSearchQ 见 state.js

  function getRecentEmojiIds() {
    try {
      const a = JSON.parse(localStorage.getItem(EMOJI_RECENT_KEY) || '[]');
      return Array.isArray(a) ? a.filter(x => typeof x === 'string') : [];
    } catch (_) { return []; }
  }
  function pushRecentEmojiId(id) {
    const a = getRecentEmojiIds().filter(x => x !== id);
    a.unshift(id);
    try { localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify(a.slice(0, 40))); } catch (_) { /* ignore */ }
  }
  function renderEmojiTabs() {
    emojiTabs.innerHTML = '';
    const tabs = [['recent', '🕘', '最近使用']].concat(
      Object.keys(EMOJI_CAT_META).map(id => [id, EMOJI_CAT_META[id][0], EMOJI_CAT_META[id][1]])
    );
    for (const [id, icon, label] of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-tab' + (id === state.emojiActiveCat ? ' active' : '');
      b.textContent = icon;
      b.title = label;
      b.dataset.cat = id;
      b.addEventListener('click', (e) => {
        e.stopPropagation(); // 关键：若重建 DOM，被点掉的按钮脱离面板，会被 document 误判为"点外面"而关闭
        if (state.emojiActiveCat === id) return;
        state.emojiActiveCat = id;
        state.emojiSearchQ = '';
        emojiSearch.value = '';
        updateEmojiTabsActive();
        renderEmojiGrid();
      });
      emojiTabs.appendChild(b);
    }
  }
  function updateEmojiTabsActive() {
    for (const b of emojiTabs.querySelectorAll('.emoji-tab')) {
      b.classList.toggle('active', b.dataset.cat === state.emojiActiveCat);
    }
  }
  function renderEmojiGrid() {
    emojiGrid.innerHTML = '';
    let items = [];
    if (state.emojiSearchQ) {
      const q = state.emojiSearchQ.toLowerCase();
      for (const [id, e] of Object.entries(EMOJI.emojis)) {
        if (!e || !e.c) continue;
        if (e.n.toLowerCase().indexOf(q) !== -1 ||
            (e.k || []).some(k => k.toLowerCase().indexOf(q) !== -1) ||
            e.c.toLowerCase().indexOf(q) !== -1) {
          items.push([id, e]);
          if (items.length >= 300) break; // 搜索结果截断，避免一次渲染过多
        }
      }
    } else if (state.emojiActiveCat === 'recent') {
      const recent = getRecentEmojiIds();
      for (const id of recent) {
        const e = EMOJI.emojis[id];
        if (e && e.c) items.push([id, e]);
      }
    } else {
      const cat = EMOJI.categories.find(c => c.id === state.emojiActiveCat);
      const ids = cat ? cat.e : [];
      for (const id of ids) {
        const e = EMOJI.emojis[id];
        if (e && e.c) items.push([id, e]);
      }
    }
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'emoji-empty';
      d.textContent = state.emojiSearchQ ? '没有匹配的表情' : (state.emojiActiveCat === 'recent' ? '还没有使用过表情' : '该分类暂无表情');
      emojiGrid.appendChild(d);
      return;
    }
    // 分批渲染（每批 80 个），大分类/搜索结果不再一次性塞入几百个节点造成卡顿
    let idx = 0;
    const BATCH = 80;
    const buildChunk = () => {
      const frag = document.createDocumentFragment();
      const end = Math.min(idx + BATCH, items.length);
      for (; idx < end; idx++) {
        const [id, e] = items[idx];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'emoji-item';
        b.textContent = e.c;
        b.title = e.n;
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          insertEmoji(e.c);
          pushRecentEmojiId(id);
          if (state.emojiActiveCat === 'recent') renderEmojiGrid(); // 最近使用：用完立即置顶
        });
        frag.appendChild(b);
      }
      emojiGrid.appendChild(frag);
      if (idx < items.length) setTimeout(buildChunk, 0);
    };
    buildChunk();
  }
  function insertEmoji(ch) {
    msgInput.focus(); // 先聚焦，保证 selectionStart/selectionEnd 有效
    const start = msgInput.selectionStart != null ? msgInput.selectionStart : msgInput.value.length;
    const end = msgInput.selectionEnd != null ? msgInput.selectionEnd : start;
    msgInput.value = msgInput.value.slice(0, start) + ch + msgInput.value.slice(end);
    const pos = start + ch.length;
    msgInput.setSelectionRange(pos, pos);
    msgInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function openEmojiPanel() {
    emojiPanel.hidden = false;
    state.emojiActiveCat = 'recent';
    state.emojiSearchQ = '';
    emojiSearch.value = '';
    renderEmojiTabs();
    renderEmojiGrid();
  }
  function closeEmojiPanel() { emojiPanel.hidden = true; }
  function toggleEmojiPanel() { emojiPanel.hidden ? openEmojiPanel() : closeEmojiPanel(); }
  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleEmojiPanel();
  });
  document.addEventListener('click', (e) => {
    if (!emojiPanel.hidden && !emojiPanel.contains(e.target) && e.target !== emojiBtn && !emojiBtn.contains(e.target)) {
      closeEmojiPanel();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEmojiPanel(); });
  emojiSearch.addEventListener('input', () => {
    state.emojiSearchQ = emojiSearch.value.trim();
    renderEmojiGrid();
  });

  // 暴露给其他分片（chat 的 sendMessage 发送前收起面板）
  Object.assign(app, {
    closeEmojiPanel
  });
})();
