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
  // 按模块分组：卡片网格 → 点击卡片进入该模块的表单
  const dataConfigBox = document.getElementById('dataConfigBox');
  const dataConfigCards = document.getElementById('dataConfigCards');
  const dataConfigForm = document.getElementById('dataConfigForm');
  const dataConfigBack = document.getElementById('dataConfigBack');
  const dataConfigFormTitle = document.getElementById('dataConfigFormTitle');
  const dataConfigGrid = document.getElementById('dataConfigGrid');
  const dataConfigTip = document.getElementById('dataConfigTip');
  const dataConfigSaveBtn = document.getElementById('dataConfigSaveBtn');
  const dataConfigReloadBtn = document.getElementById('dataConfigReloadBtn');

  const CONFIG_LABELS = {
    port: '服务端口', uploadDir: '上传目录', dbFile: '数据库文件', localAddrs: '宿主机地址白名单',
    fileTtlDays: '文件保留天数', maxUploadMB: 'uploads 容量上限(MB)', msgTtlDays: '消息保留天数',
    remindTickMs: '日程提醒轮询(ms)', translateUrl: '翻译引擎地址(即时生效)', translateGtx: '允许谷歌免费端点回退',
    botEnabled: '启用 AI 机器人', botName: '机器人昵称', botBaseUrl: '接口地址（OpenAI 兼容）',
    botApiKey: 'API Key（只写，不回显）', botModel: '模型名', botPrompt: '系统提示词（可选）',
    botContextN: '上下文条数', botTimeoutMs: '生成超时(ms)'
  };

  // 按模块分组的配置项
  const CONFIG_GROUPS = [
    { id: 'network',  title: '服务与网络', desc: '服务端口 · 宿主机地址白名单', fields: ['port', 'localAddrs'] },
    { id: 'storage',  title: '存储与保留', desc: '上传/数据库位置 · 文件与消息保留 · 容量上限', fields: ['uploadDir', 'dbFile', 'fileTtlDays', 'maxUploadMB', 'msgTtlDays'] },
    { id: 'remind',   title: '日程提醒',   desc: '提醒轮询间隔', fields: ['remindTickMs'] },
    { id: 'translate', title: '翻译',      desc: '翻译引擎地址 · 谷歌端点回退', fields: ['translateUrl', 'translateGtx'] },
    { id: 'bot',      title: 'AI 机器人',  desc: 'OpenAI 兼容接口 · @提及触发 · 全房间可用', fields: ['botEnabled', 'botName', 'botBaseUrl', 'botApiKey', 'botModel', 'botPrompt', 'botContextN', 'botTimeoutMs'] }
  ];

  let currentCfg = null;      // 最近一次拉取/保存后的生效配置（含 *Restart 标记）
  let currentGroupId = null;  // 当前打开的表单所属模块

  // 渲染单个模块的表单（只画该模块的字段；按值类型自适应控件）
  function renderConfigCard(fields) {
    dataConfigGrid.innerHTML = '';
    for (const k of fields) {
      const label = CONFIG_LABELS[k];
      if (!label) continue;
      const row = document.createElement('label');
      row.className = 'data-config-item';
      const needsRestart = currentCfg && currentCfg[k + 'Restart'];
      row.innerHTML = `<span class="data-config-label">${escapeHtml(label)}${needsRestart ? ' <em>重启</em>' : ''}</span>`;
      const v = currentCfg && currentCfg[k];
      if (typeof v === 'boolean') {
        // 开关类
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'data-config-check';
        input.dataset.key = k;
        input.checked = !!v;
        row.appendChild(input);
      } else if (k === 'botPrompt') {
        // 长文本（系统提示词）
        const ta = document.createElement('textarea');
        ta.className = 'modal-input data-config-prompt';
        ta.dataset.key = k;
        ta.rows = 3;
        ta.placeholder = '（可选）定义机器人角色与回答风格';
        ta.value = v === undefined ? '' : String(v);
        row.appendChild(ta);
      } else if (k === 'botApiKey') {
        // 密码框：只写不回显，留空表示保持原值
        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'modal-input';
        input.dataset.key = k;
        input.placeholder = '已保存，留空则不改';
        row.appendChild(input);
      } else {
        const input = document.createElement('input');
        input.className = 'modal-input';
        input.dataset.key = k;
        input.type = typeof v === 'number' ? 'number' : 'text';
        input.value = v === undefined ? '' : String(v);
        row.appendChild(input);
      }
      dataConfigGrid.appendChild(row);
    }
  }

  // 渲染模块卡片网格
  function renderConfigCards() {
    dataConfigCards.innerHTML = '';
    for (const g of CONFIG_GROUPS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'data-config-card';
      card.innerHTML =
        `<span class="data-config-card-title">${escapeHtml(g.title)}</span>` +
        `<span class="data-config-card-desc">${escapeHtml(g.desc)}</span>` +
        `<span class="data-config-card-count">${g.fields.length} 项配置</span>`;
      card.addEventListener('click', () => openConfigForm(g.id));
      dataConfigCards.appendChild(card);
    }
  }

  // 进入某模块的表单
  function openConfigForm(groupId) {
    const g = CONFIG_GROUPS.find((x) => x.id === groupId);
    if (!g) return;
    currentGroupId = groupId;
    dataConfigFormTitle.textContent = g.title;
    renderConfigCard(g.fields);
    dataConfigTip.textContent = '';
    dataConfigTip.className = 'data-config-tip';
    dataConfigReloadBtn.hidden = true;
    dataConfigCards.hidden = true;
    dataConfigForm.hidden = false;
  }

  function backConfigForm() {
    currentGroupId = null;
    dataConfigForm.hidden = true;
    dataConfigCards.hidden = false;
  }

  function loadConfigCard() {
    fetch('/api/config')
      .then((r) => r.json())
      .then((j) => {
        if (!j || !j.ok) return;
        currentCfg = j.config;
        renderConfigCards();
        dataConfigBox.hidden = false;
      })
      .catch(() => { dataConfigBox.hidden = true; });
  }

  dataConfigBack.addEventListener('click', backConfigForm);

  dataConfigSaveBtn.addEventListener('click', async () => {
    const g = CONFIG_GROUPS.find((x) => x.id === currentGroupId);
    const updates = {};
    dataConfigGrid.querySelectorAll('input, textarea').forEach((el) => {
      const k = el.dataset.key;
      if (el.type === 'checkbox') updates[k] = el.checked;
      else if (k === 'botApiKey' && !el.value) { /* 留空 = 保持原 key 不回写 */ }
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
        currentCfg = j.config;
        if (g) renderConfigCard(g.fields); // 刷新当前表单（更新「重启」徽标）
        renderConfigCards();               // 刷新卡片列表
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
