/* 数据面板：历史消息搜索 / 统计 / 导出备份 / 清空历史
 * 依赖 client.js 先加载（window.chatApp.socket / utils）与 share.js 的 Tab 注册制 */
(function () {
  'use strict';

  if (!window.chatApp) return;
  const socket = window.chatApp.socket;
  const { escapeHtml, fmtTime } = window.chatApp.utils;

  // ---------- DOM ----------
  const tabData = document.getElementById('tabData');
  const dataView = document.getElementById('dataView');
  const statMessages = document.getElementById('statMessages');
  const statFiles = document.getElementById('statFiles');
  const statStrokes = document.getElementById('statStrokes');
  const statDbSize = document.getElementById('statDbSize');
  const dataRange = document.getElementById('dataRange');
  const dataDbPath = document.getElementById('dataDbPath');
  const keywordInput = document.getElementById('dataSearchKeyword');
  const nickInput = document.getElementById('dataSearchNick');
  const searchBtn = document.getElementById('dataSearchBtn');
  const searchReset = document.getElementById('dataSearchReset');
  const searchMeta = document.getElementById('dataSearchMeta');
  const resultsBox = document.getElementById('dataResults');
  const exportBtn = document.getElementById('dataExportBtn');
  const clearBtn = document.getElementById('dataClearBtn');
  const hintEl = document.getElementById('dataHint');

  function setHint(text, cls) {
    hintEl.textContent = text;
    hintEl.className = 'upload-hint show' + (cls ? ' ' + cls : '');
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  // ---------- 统计 ----------
  function refreshStats() {
    socket.emit('history_stats', (res) => {
      if (!res || !res.ok) return;
      statMessages.textContent = res.messages;
      statFiles.textContent = res.files;
      statStrokes.textContent = res.strokes;
      statDbSize.textContent = fmtBytes(res.dbBytes);
      const first = res.firstAt ? fmtTime(res.firstAt) : '—';
      const last = res.lastAt ? fmtTime(res.lastAt) : '—';
      dataRange.textContent = `最早记录：${first} · 最新记录：${last}`;
    });
  }

  // ---------- 搜索结果渲染 ----------
  function renderResults(msgs) {
    resultsBox.innerHTML = '';
    if (!msgs || !msgs.length) {
      const div = document.createElement('div');
      div.className = 'data-empty';
      div.textContent = '没有匹配的消息';
      resultsBox.appendChild(div);
      return;
    }
    searchMeta.textContent = `找到 ${msgs.length} 条结果`;
    msgs.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'data-result';
      const icon = m.type === 'image' ? '🖼' : m.type === 'file' ? '📄' : '💬';
      const body = m.type === 'text' ? (m.text || '') : (m.fileName || '文件');
      row.innerHTML =
        `<span class="data-result-icon">${icon}</span>` +
        `<span class="data-result-nick">${escapeHtml(m.nickname)}</span>` +
        `<span class="data-result-body">${escapeHtml(String(body).slice(0, 120))}</span>` +
        `<span class="data-result-time">${fmtTime(m.timestamp)}</span>`;
      row.title = m.type === 'text' ? m.text : m.fileName;
      resultsBox.appendChild(row);
    });
  }

  function doSearch() {
    const keyword = keywordInput.value.trim();
    const nick = nickInput.value.trim();
    searchBtn.disabled = true;
    socket.emit('history_search', { keyword, nickname: nick, limit: 100 }, (res) => {
      searchBtn.disabled = false;
      if (!res || !res.ok) {
        renderResults([]);
        searchMeta.textContent = res && res.error ? res.error : '搜索失败';
        return;
      }
      renderResults(res.results);
      searchReset.hidden = false;
    });
  }

  // ---------- 事件绑定 ----------
  window.chatApp.registerTab('data', tabData, [dataView]);
  tabData.addEventListener('click', refreshStats);
  searchBtn.addEventListener('click', doSearch);
  keywordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  nickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  searchReset.addEventListener('click', () => {
    keywordInput.value = '';
    nickInput.value = '';
    searchReset.hidden = true;
    searchMeta.textContent = '';
    resultsBox.innerHTML =
      '<div class="data-empty">搜索历史消息，或查看下方统计。数据保存在宿主机 data/chat.db（SQLite）。</div>';
  });

  // 导出备份：直接下载服务器上的 chat.db
  exportBtn.addEventListener('click', () => {
    window.location.href = '/data-export';
    setHint('正在下载数据库备份…', '');
  });

  // 清空历史（二次确认）
  clearBtn.addEventListener('click', () => {
    if (!confirm('确定清空全部聊天历史吗？此操作不可恢复。\n（白板笔迹会一并清空）')) return;
    socket.emit('history_clear', { includeStrokes: true }, (res) => {
      if (res && res.ok) {
        setHint(`已清空 ${res.messages} 条消息`, 'success');
        refreshStats();
      } else {
        setHint((res && res.error) || '清空失败', '');
      }
    });
  });

  // 初次进入数据面板时刷新统计
  refreshStats();
})();
