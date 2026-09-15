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
  const statDiskFiles = document.getElementById('statDiskFiles');
  const statDiskBytes = document.getElementById('statDiskBytes');
  const dataRange = document.getElementById('dataRange');
  const dataRetention = document.getElementById('dataRetention');
  const sweepBtn = document.getElementById('dataSweepBtn');
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
      if (res.disk) {
        statDiskFiles.textContent = res.disk.files;
        statDiskBytes.textContent = fmtBytes(res.disk.bytes);
      }
      if (res.retention) {
        const r = res.retention;
        const filePart = r.fileTtlDays > 0 ? `文件保留 ${r.fileTtlDays} 天` : '文件不限期';
        const capPart = r.maxUploadMB > 0 ? `容量上限 ${r.maxUploadMB}MB` : '容量不限';
        const msgPart = r.msgTtlDays > 0 ? `消息保留 ${r.msgTtlDays} 天` : '消息永久保留';
        dataRetention.textContent = `保留策略：${filePart} · ${capPart} · ${msgPart}（每 ${r.sweepIntervalMin} 分钟自动清扫）`;
      }
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

  // ---------- 服务器配置卡（仅宿主机） ----------
  const dataConfigBox = document.getElementById('dataConfigBox');
  const dataConfigGrid = document.getElementById('dataConfigGrid');
  const dataConfigTip = document.getElementById('dataConfigTip');
  const dataConfigSaveBtn = document.getElementById('dataConfigSaveBtn');
  const dataConfigReloadBtn = document.getElementById('dataConfigReloadBtn');

  const CONFIG_LABELS = {
    port: '服务端口', uploadDir: '上传目录', dbFile: '数据库文件', localAddrs: '宿主机地址白名单',
    fileTtlDays: '文件保留天数', maxUploadMB: 'uploads 容量上限(MB)', msgTtlDays: '消息保留天数',
    remindTickMs: '日程提醒轮询(ms)', translateUrl: '翻译引擎地址(即时生效)', translateGtx: '允许谷歌免费端点回退'
  };

  function renderConfigCard(cfg) {
    dataConfigGrid.innerHTML = '';
    for (const [k, label] of Object.entries(CONFIG_LABELS)) {
      const row = document.createElement('label');
      row.className = 'data-config-item';
      const needsRestart = cfg[k + 'Restart'];
      row.innerHTML = `<span class="data-config-label">${escapeHtml(label)}${needsRestart ? ' <em>重启</em>' : ''}</span>`;
      const input = document.createElement('input');
      input.className = 'modal-input';
      input.dataset.key = k;
      if (k === 'translateGtx') {
        input.type = 'checkbox';
        input.checked = !!cfg[k];
        input.classList.add('data-config-check');
      } else {
        input.type = k === 'port' || k.endsWith('Days') || k.endsWith('MB') || k.endsWith('Ms') ? 'number' : 'text';
        input.value = cfg[k] === undefined ? '' : String(cfg[k]);
      }
      row.appendChild(input);
      dataConfigGrid.appendChild(row);
    }
  }

  function loadConfigCard() {
    fetch('/api/config')
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) return;
        renderConfigCard(j.config);
        dataConfigBox.hidden = false;
      })
      .catch(() => { dataConfigBox.hidden = true; });
  }

  dataConfigSaveBtn.addEventListener('click', async () => {
    const updates = {};
    dataConfigGrid.querySelectorAll('input').forEach((el) => {
      const k = el.dataset.key;
      if (el.type === 'checkbox') updates[k] = el.checked;
      else updates[k] = el.value;
    });
    dataConfigSaveBtn.disabled = true;
    try {
      const r = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: updates })
      });
      const j = await r.json();
      if (!j.ok) {
        dataConfigTip.textContent = (j.error) || '保存失败';
        dataConfigTip.className = 'data-config-tip err';
      } else {
        const restart = j.restartNeeded && j.restartNeeded.length;
        dataConfigTip.textContent = restart
          ? `已保存，以下项需重启生效：${j.restartNeeded.join('、')}`
          : '已保存';
        dataConfigTip.className = 'data-config-tip';
        dataConfigReloadBtn.hidden = !restart;
        renderConfigCard(j.config);
      }
    } catch (_) {
      dataConfigTip.textContent = '保存失败（网络错误）';
      dataConfigTip.className = 'data-config-tip err';
    } finally {
      dataConfigSaveBtn.disabled = false;
    }
  });
  dataConfigReloadBtn.addEventListener('click', () => window.location.reload());

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

  // 导出备份：直接下载服务器上的 chat.db（仅宿主机）
  exportBtn.addEventListener('click', () => {
    window.location.href = '/data-export';
    setHint('正在下载数据库备份…', '');
  });

  // 清空历史（二次确认；仅宿主机）
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

  // 立即清理（仅宿主机）：执行一次生命周期清扫（过期文件/容量/孤儿/碎片/过期消息）
  sweepBtn.addEventListener('click', () => {
    sweepBtn.disabled = true;
    setHint('正在清理…', '');
    socket.emit('lifecycle_sweep', (res) => {
      sweepBtn.disabled = false;
      if (!res || !res.ok) {
        setHint((res && res.error) || '清理失败', 'error');
        return;
      }
      const f = res.report.files;
      const m = res.report.messages;
      const freed = f.bytesFreed >= 1024 * 1024 ? (f.bytesFreed / 1024 / 1024).toFixed(1) + 'MB' : Math.round(f.bytesFreed / 1024) + 'KB';
      setHint(
        `清理完成：过期文件 ${f.ttlDeleted} · 容量淘汰 ${f.lruDeleted} · 孤儿 ${f.orphansDeleted} · 碎片 ${f.tmpDirsDeleted} · 过期消息 ${m.messages}，释放 ${freed}`,
        'success'
      );
      refreshStats();
    });
  });

  // 数据管理操作（导出/清空/清理/配置）仅宿主机可见可用。
  // isLocal 在 welcome 事件到达后才有值，因此门禁必须在 welcome 时应用（含重连），不能在加载时一刀切
  function applyAdminGate() {
    const isAdmin = !!window.chatApp.isLocal;
    exportBtn.hidden = !isAdmin;
    clearBtn.hidden = !isAdmin;
    sweepBtn.hidden = !isAdmin;
    if (isAdmin) loadConfigCard();
    if (!isAdmin) {
      setHint('数据导出、清理、清空与配置仅宿主机可用', '');
    } else if (hintEl.textContent === '数据导出、清理、清空与配置仅宿主机可用') {
      setHint('', '');
    }
  }
  socket.on('welcome', applyAdminGate);
  applyAdminGate();

  // 初次进入数据面板时刷新统计
  refreshStats();
})();
