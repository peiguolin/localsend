/* 文件夹共享面板：共享列表 / 文件浏览器 / 共享者本地代理（File System Access API） */
(function () {
  'use strict';

  if (!window.chatApp) return; // 依赖 client.js 先加载
  const socket = window.chatApp.socket;
  const { escapeHtml, fmtSize } = window.chatApp.utils;

  // ---------- DOM 引用 ----------
  const tabChat = document.getElementById('tabChat');
  const tabShare = document.getElementById('tabShare');
  const chatMain = document.getElementById('chatMain');
  const inputbar = document.querySelector('.inputbar');
  const shareView = document.getElementById('shareView');

  const shareHome = document.getElementById('shareHome');
  const shareBrowser = document.getElementById('shareBrowser');
  const createShareBtn = document.getElementById('createShareBtn');
  const myShareBox = document.getElementById('myShareBox');
  const shareList = document.getElementById('shareList');
  const shareEmpty = document.getElementById('shareEmpty');
  const shareHomeHint = document.getElementById('shareHomeHint');

  const browserBackBtn = document.getElementById('browserBackBtn');
  const browserRefreshBtn = document.getElementById('browserRefreshBtn');
  const breadcrumb = document.getElementById('breadcrumb');
  const browserMeta = document.getElementById('browserMeta');
  const browserRows = document.getElementById('browserRows');
  const browserEmpty = document.getElementById('browserEmpty');
  const browserLoading = document.getElementById('browserLoading');
  const shareUploadBtn = document.getElementById('shareUploadBtn');
  const shareUploadInput = document.getElementById('shareUploadInput');
  const shareBrowserHint = document.getElementById('shareBrowserHint');

  const createShareModal = document.getElementById('createShareModal');
  const csName = document.getElementById('csName');
  const csPassword = document.getElementById('csPassword');
  const csWritable = document.getElementById('csWritable');
  const csTip = document.getElementById('csTip');
  const csConfirm = document.getElementById('csConfirm');
  const csCancel = document.getElementById('csCancel');

  const pwdModal = document.getElementById('pwdModal');
  const pwdTitle = document.getElementById('pwdTitle');
  const pwdInput = document.getElementById('pwdInput');
  const pwdError = document.getElementById('pwdError');
  const pwdConfirm = document.getElementById('pwdConfirm');
  const pwdCancel = document.getElementById('pwdCancel');

  const manageShareModal = document.getElementById('manageShareModal');
  const msName = document.getElementById('msName');
  const msPassword = document.getElementById('msPassword');
  const msClearPassword = document.getElementById('msClearPassword');
  const msWritable = document.getElementById('msWritable');
  const msTip = document.getElementById('msTip');
  const msConfirm = document.getElementById('msConfirm');
  const msCancel = document.getElementById('msCancel');

  // ---------- 状态 ----------
  const fsSupported = 'showDirectoryPicker' in window;
  let shares = [];               // 服务器推送的共享列表
  let myShare = null;            // { id, name, dirHandle, canWrite, password }

  // ---------- 下载管理（分段断点续传；dl-core 纯逻辑 + OPFS 持久化） ----------
  const dlManager = document.getElementById('dlManager');
  const dlList = document.getElementById('dlList');
  const dlEmpty = document.getElementById('dlEmpty');

  // OPFS 存储：段数据写 OPFS，刷新页面后 restoreAll 续传（已下段不重下）；不支持则内存降级（不跨刷新）
  function opfsStorage() {
    if (!navigator.storage || !navigator.storage.getDirectory) return null;
    let rootP;
    const root = () => (rootP || (rootP = navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('localsend-dl', { create: true }))));
    return {
      async listMeta() {
        const dir = await root();
        const out = [];
        for await (const [name] of dir.entries()) if (name.endsWith('.json')) out.push(name.slice(0, -5));
        return out;
      },
      async loadMeta(key) {
        try { const f = await (await root()).getFileHandle(key + '.json'); return JSON.parse(await (await f.getFile()).text()); } catch (_) { return null; }
      },
      async saveMeta(key, meta) {
        try { const fh = await (await root()).getFileHandle(key + '.json', { create: true }); const w = await fh.createWritable(); await w.write(JSON.stringify(meta)); await w.close(); } catch (_) {}
      },
      async deleteMeta(key) { try { await (await root()).removeEntry(key + '.json'); } catch (_) {} },
      async readSegment(key, index) {
        try { const fh = await (await root()).getFileHandle(`${key}.${index}.seg`); return await (await fh.getFile()); } catch (_) { return null; }
      },
      async writeSegment(key, index, blob) {
        try { const fh = await (await root()).getFileHandle(`${key}.${index}.seg`, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); } catch (_) {}
      },
      async deleteSegments(key) {
        try { const dir = await root(); for await (const [name] of dir.entries()) if (name.startsWith(key + '.') && name.endsWith('.seg')) await dir.removeEntry(name).catch(() => {}); } catch (_) {}
      }
    };
  }

  const dlStorage = opfsStorage();
  const downloader = new window.chatApp.dlCore.SegmentDownloader({
    storage: dlStorage,
    onProgress: renderDownloads,
    onState: renderDownloads,
    onDone: (h) => { renderDownloads(); setHint(shareBrowserHint, `「${h.name}」下载完成`, 'success'); },
    onError: (h) => { renderDownloads(); setHint(shareBrowserHint, `「${h.name}」下载失败：${h.error}`, 'error'); }
  });

  const DL_STATUS = { idle: '等待', downloading: '下载中', paused: '已暂停', done: '已完成', error: '失败', cancelled: '已取消' };
  const fmtPct = (h) => (h.size ? Math.min(100, Math.round((h.doneBytes / h.size) * 100)) : 0);

  function renderDownloads() {
    const list = downloader.all();
    dlManager.hidden = list.length === 0;
    dlEmpty.hidden = list.length > 0;
    dlList.innerHTML = list.map((h) => {
      const pct = fmtPct(h);
      const status = DL_STATUS[h.status] || h.status;
      const btns = [];
      if (h.status === 'done') {
        btns.push(`<button class="dl-btn primary" data-k="${escapeHtml(h.key)}" data-act="save">另存为</button>`);
        btns.push(`<button class="dl-btn" data-k="${escapeHtml(h.key)}" data-act="clear">清除</button>`);
      } else if (h.status === 'error') {
        btns.push(`<button class="dl-btn" data-k="${escapeHtml(h.key)}" data-act="clear">移除</button>`);
      } else {
        const resume = h.paused || h.status === 'idle';
        btns.push(`<button class="dl-btn" data-k="${escapeHtml(h.key)}" data-act="${resume ? 'resume' : 'pause'}">${resume ? (h.status === 'idle' ? '开始' : '继续') : '暂停'}</button>`);
        btns.push(`<button class="dl-btn" data-k="${escapeHtml(h.key)}" data-act="cancel">取消</button>`);
      }
      const errTip = h.error ? `<div class="dl-err">${escapeHtml(h.error)}</div>` : '';
      return `
        <div class="dl-item" data-k="${escapeHtml(h.key)}">
          <div class="dl-row1">
            <span class="dl-name" title="${escapeHtml(h.name)}">${escapeHtml(h.name)}</span>
            <span class="dl-status ${h.status === 'error' ? 'error' : ''}">${status}${h.status === 'downloading' ? ` ${pct}%` : ''}</span>
          </div>
          <span class="dl-progress"><span class="dl-progress-bar" style="width:${pct}%"></span></span>
          <div class="dl-row2">
            <span class="dl-meta">${fmtSize(h.size)} · ${fmtSize(h.doneBytes)} / ${fmtSize(h.size)}</span>
            <span class="dl-ops">${btns.join('')}</span>
          </div>
          ${errTip}
        </div>`;
    }).join('');
  }

  function startDownload(share, fullPath, name, size) {
    const token = tokens.get(share.id) || '';
    const url = `/api/share/${encodeURIComponent(share.id)}/file?path=${encodeURIComponent(fullPath)}&token=${encodeURIComponent(token)}`;
    const key = `${share.id}:${fullPath}`;
    downloader.newDownload({ key, url, name, size });
    renderDownloads();
    downloader.resume(key);
    setHint(shareBrowserHint, `开始下载 ${name}`, 'success');
  }

  function saveDownloaded(key) {
    const h = downloader.handle(key);
    if (!h || !h.blobUrl) return;
    const a = document.createElement('a');
    a.href = h.blobUrl;
    a.download = h.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  dlList.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const key = btn.dataset.k;
    const act = btn.dataset.act;
    if (act === 'pause') downloader.pause(key);
    else if (act === 'resume') downloader.resume(key);
    else if (act === 'cancel') downloader.cancel(key);
    else if (act === 'clear') downloader.remove(key);
    else if (act === 'save') saveDownloaded(key);
  });


  const tokens = new Map();      // shareId -> 访问 token
  let current = null;            // 正在浏览的 { share, path: [seg, ...] }
  let pendingPwdShare = null;    // 正在输入密码的共享
  const shareStore = window.chatApp.shareStore || null;

  const ICON_DIR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  const ICON_FILE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';

  // ---------- 工具 ----------
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function setHint(el, text, cls) {
    el.textContent = text || '';
    el.className = 'upload-hint' + (text ? ' show' : '') + (cls ? ' ' + cls : '');
  }

  function openModal(m) { m.hidden = false; }
  function closeModal(m) { m.hidden = true; }
  [createShareModal, pwdModal, manageShareModal].forEach((m) => {
    m.querySelector('.modal-backdrop').addEventListener('click', () => closeModal(m));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    [createShareModal, pwdModal, manageShareModal].forEach(closeModal);
  });

  // ---------- 视图切换（Tab 注册制；whiteboard.js 也会注册自己的 Tab） ----------
  const tabRegistry = new Map(); // name -> { btn, panels }
  function switchView(name) {
    for (const [n, t] of tabRegistry) {
      const on = n === name;
      t.btn.classList.toggle('active', on);
      t.panels.forEach((p) => { p.hidden = !on; });
    }
  }
  function registerTab(name, btn, panels) {
    if (!btn || !panels) return;
    tabRegistry.set(name, { btn, panels });
    btn.addEventListener('click', () => switchView(name));
  }
  registerTab('chat', tabChat, [chatMain, inputbar]);
  registerTab('share', tabShare, [shareView]);
  window.chatApp.switchView = switchView;
  window.chatApp.registerTab = registerTab;

  function showShareHome() {
    current = null;
    shareBrowser.hidden = true;
    shareHome.hidden = false;
    renderShares();
  }

  // ---------- 共享列表 ----------
  function renderShares() {
    // 我的共享盒子
    if (myShare) {
      const info = shares.find((s) => s.id === myShare.id);
      myShareBox.hidden = false;
      myShareBox.innerHTML = `
        <div class="my-share-info">
          <span class="share-icon owner">${ICON_DIR}</span>
          <div class="share-names">
            <div class="share-name">${escapeHtml(myShare.name)} <span class="tag tag-me">我的共享</span></div>
            <div class="share-sub">
              ${info && info.locked ? '<span class="tag tag-lock">密码</span>' : '<span class="tag">无密码</span>'}
              ${info && info.writable ? '<span class="tag tag-write">可写入</span>' : '<span class="tag">只读</span>'}
              <span class="share-sub-dim">共享期间请勿关闭本页面</span>
            </div>
          </div>
          <div class="my-share-btns">
            <button class="tool-btn" id="myShareManage" type="button">管理</button>
            <button class="tool-btn danger" id="myShareStop" type="button">取消共享</button>
          </div>
        </div>`;
      document.getElementById('myShareManage').addEventListener('click', openManageModal);
      document.getElementById('myShareStop').addEventListener('click', stopShare);
    } else {
      myShareBox.hidden = true;
      myShareBox.innerHTML = '';
    }

    // 共享列表
    shareList.innerHTML = '';
    shareEmpty.hidden = shares.length > 0;
    const sorted = shares.slice().sort((a, b) => a.createdAt - b.createdAt);
    for (const s of sorted) {
      const isMine = myShare && s.id === myShare.id;
      const li = document.createElement('li');
      li.className = 'share-item';
      li.innerHTML = `
        <span class="share-icon">${ICON_DIR}</span>
        <div class="share-names">
          <div class="share-name">${escapeHtml(s.name)}</div>
          <div class="share-sub">
            <span class="share-owner">${escapeHtml(s.owner)}</span>
            ${s.locked ? '<span class="tag tag-lock">密码</span>' : ''}
            ${s.writable ? '<span class="tag tag-write">可写入</span>' : ''}
            ${isMine ? '<span class="tag tag-me">我</span>' : ''}
          </div>
        </div>
        <button class="share-primary-btn small" type="button">进入</button>`;
      li.querySelector('button').addEventListener('click', () => enterShare(s));
      shareList.appendChild(li);
    }
  }

  socket.on('shares_update', (list) => {
    shares = Array.isArray(list) ? list : [];
    // 我的共享在服务器端已消失（如服务器重启）→ 本地状态复位
    if (myShare && !shares.some((s) => s.id === myShare.id)) {
      myShare = null;
      if (current && !shares.some((s) => s.id === current.share.id)) showShareHome();
    }
    // 正在浏览的共享被关闭 → 回列表
    if (current && !shares.some((s) => s.id === current.share.id)) {
      showShareHome();
      setHint(shareHomeHint, '该共享已被对方关闭', 'error');
    }
    renderShares();
  });

  // 断线重连后：旧的共享与 token 均失效
  socket.on('connect', () => {
    if (myShare) {
      myShare = null;
      setHint(shareHomeHint, '连接已断开重连，如需继续共享请重新创建', 'error');
    }
    tokens.clear();
    if (current) {
      const s = shares.find((x) => x.id === current.share.id);
      if (s) enterShare(s);
      else showShareHome();
    }
    renderShares();
    // 连接就绪后尝试恢复上次共享（句柄权限仍授予则自动恢复，否则显示恢复条）
    tryRestoreShare();
  });

  // ---------- 创建 / 管理 / 取消共享 ----------
  createShareBtn.addEventListener('click', () => {
    if (myShare) {
      setHint(shareHomeHint, '你已有共享中的文件夹，请先取消', 'error');
      return;
    }
    if (!fsSupported) {
      setHint(shareHomeHint, '当前浏览器不支持共享文件夹，请使用 Chrome / Edge', 'error');
      return;
    }
    csName.value = '';
    csPassword.value = '';
    csWritable.checked = false;
    csTip.classList.remove('error');
    csTip.textContent = '确认后会弹出系统文件夹选择器，选择要共享的文件夹（需 Chrome / Edge，共享期间本页面需保持打开）';
    openModal(createShareModal);
  });

  csCancel.addEventListener('click', () => closeModal(createShareModal));

  csConfirm.addEventListener('click', async () => {
    const wantWrite = csWritable.checked;
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: wantWrite ? 'readwrite' : 'read' });
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        csTip.classList.add('error');
        csTip.textContent = '无法打开文件夹选择器：' + (e.message || e);
      }
      return; // 用户取消则停留在弹窗
    }
    // 确认写权限是否真正授予（用户可能在系统弹窗中拒绝了编辑权限）
    let canWrite = false;
    if (wantWrite) {
      try {
        canWrite = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
      } catch (_) { canWrite = false; }
    }
    const name = csName.value.trim() || handle.name;
    const password = csPassword.value || '';
    csConfirm.disabled = true;
    socket.emit('share_register', {
      name, password: password || null, writable: canWrite
    }, (res) => {
      csConfirm.disabled = false;
      if (!res || !res.ok) {
        csTip.classList.add('error');
        csTip.textContent = (res && res.error) || '创建共享失败';
        return;
      }
      myShare = { id: res.shareId, name, dirHandle: handle, canWrite, password: password || null };
      tokens.set(res.shareId, res.token);
      closeModal(createShareModal);
      // 持久化句柄：刷新页面后自动恢复共享（权限仍授予时）
      if (shareStore) shareStore.save({ name, password: password || null, writable: canWrite, handle }).catch(() => {});
      const restoreBox = document.getElementById('restoreShareBox');
      if (restoreBox) restoreBox.hidden = true;
      renderShares();
      setHint(
        shareHomeHint,
        wantWrite && !canWrite
          ? '已开始共享（未获得写入授权，当前为只读共享）'
          : `已开始共享「${name}」`,
        'success'
      );
    });
  });

  function openManageModal() {
    if (!myShare) return;
    const info = shares.find((s) => s.id === myShare.id);
    msName.value = myShare.name;
    msPassword.value = '';
    msClearPassword.checked = false;
    msWritable.checked = !!(info && info.writable);
    msWritable.disabled = !myShare.canWrite;
    msTip.textContent = myShare.canWrite
      ? '修改密码后，已访问的其他成员需要重新输入密码'
      : '创建共享时未获得写入授权，无法开启写入；修改密码后其他成员需要重新输入密码';
    openModal(manageShareModal);
  }

  msCancel.addEventListener('click', () => closeModal(manageShareModal));

  msConfirm.addEventListener('click', () => {
    if (!myShare) return;
    const payload = {
      shareId: myShare.id,
      name: msName.value,
      writable: msWritable.checked && myShare.canWrite
    };
    if (msClearPassword.checked) payload.password = null;           // 取消密码
    else if (msPassword.value) payload.password = msPassword.value; // 重设密码
    msConfirm.disabled = true;
    socket.emit('share_update', payload, (res) => {
      msConfirm.disabled = false;
      if (!res || !res.ok) {
        msTip.textContent = (res && res.error) || '保存失败';
        return;
      }
      myShare.name = res.share.name;
      if (payload.password === null) myShare.password = null;
      else if (payload.password) myShare.password = payload.password;
      closeModal(manageShareModal);
      // 同步句柄记录（改名/改密码后刷新恢复用新配置）
      if (shareStore && myShare.dirHandle) {
        shareStore.save({ name: myShare.name, password: myShare.password, writable: myShare.canWrite, handle: myShare.dirHandle }).catch(() => {});
      }
      renderShares();
      setHint(shareHomeHint, '共享设置已保存', 'success');
    });
  });

  function stopShare() {
    if (!myShare) return;
    socket.emit('share_unregister', { shareId: myShare.id }, () => {
      myShare = null;
      // 主动取消共享 → 清除句柄记录（下次刷新不再自动恢复，避免"关不掉"的错觉）
      if (shareStore) shareStore.clear().catch(() => {});
      renderShares();
      setHint(shareHomeHint, '已取消共享', 'success');
    });
  }

  // ============================================================
  //  共享句柄持久化恢复：页面刷新后自动恢复上次共享（权限已授予时）
  // ============================================================
  function doRestore(rec) {
    if (!shareStore) return;
    socket.emit('share_register', {
      name: rec.name, password: rec.password || null, writable: !!rec.writable
    }, (res) => {
      if (res && res.ok) {
        myShare = { id: res.shareId, name: rec.name || res.name || '恢复的共享', dirHandle: rec.handle, canWrite: !!rec.writable, password: rec.password || null };
        tokens.set(res.shareId, res.token);
        renderShares();
        setHint(shareHomeHint, `已自动恢复共享「${myShare.name}」`, 'success');
      } else {
        setHint(shareHomeHint, (res && res.error) || '恢复共享失败', 'error');
      }
    });
  }

  // 权限需重新授权时（readwrite 模式刷新后通常要手势）→ 显示一键恢复条
  function showRestoreBar(rec) {
    const box = document.getElementById('restoreShareBox');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `
      <span class="restore-share-info">📁 检测到上次共享的「${escapeHtml(rec.name)}」</span>
      <button class="tool-btn" id="restoreShareBtn" type="button">恢复共享</button>`;
    box.querySelector('#restoreShareBtn').addEventListener('click', async () => {
      let perm;
      try { perm = await shareStore.requestPermission(rec.handle, !!rec.writable); } catch (_) { perm = 'denied'; }
      if (perm === 'granted') {
        box.hidden = true;
        doRestore(rec);
      } else {
        setHint(shareHomeHint, '未获得该文件夹的访问授权，无法恢复共享', 'error');
      }
    });
  }

  async function tryRestoreShare() {
    if (myShare || !shareStore || !shareStore.isSupported) return;
    let rec;
    try { rec = await shareStore.load(); } catch (_) { return; }
    if (!rec || !rec.handle) return;
    let perm;
    try { perm = await shareStore.queryPermission(rec.handle, !!rec.writable); } catch (_) { perm = 'prompt'; }
    if (perm === 'granted') doRestore(rec);
    else if (perm === 'prompt') showRestoreBar(rec);
    // denied：句柄已失效，静默忽略
  }

  // ---------- 进入共享（密码校验） ----------
  function enterShare(share, password) {
    socket.emit('share_enter', { shareId: share.id, password }, (res) => {
      if (res && res.ok) {
        tokens.set(share.id, res.token);
        closeModal(pwdModal);
        openBrowser(res.share || share);
      } else if (res && res.needPassword) {
        pendingPwdShare = share;
        pwdTitle.textContent = `「${share.name}」需要访问密码`;
        pwdError.hidden = !res.error || res.error === '该共享需要密码';
        pwdError.textContent = res.error || '';
        pwdInput.value = '';
        openModal(pwdModal);
        pwdInput.focus();
      } else {
        setHint(shareHomeHint, (res && res.error) || '进入共享失败', 'error');
      }
    });
  }

  pwdConfirm.addEventListener('click', () => {
    if (pendingPwdShare) enterShare(pendingPwdShare, pwdInput.value);
  });
  pwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && pendingPwdShare) enterShare(pendingPwdShare, pwdInput.value);
  });
  pwdCancel.addEventListener('click', () => {
    pendingPwdShare = null;
    closeModal(pwdModal);
  });

  // ---------- 文件浏览器 ----------
  function openBrowser(share) {
    current = { share, path: [] };
    shareHome.hidden = true;
    shareBrowser.hidden = false;
    shareUploadBtn.hidden = !share.writable;
    loadDir();
  }

  browserBackBtn.addEventListener('click', showShareHome);
  browserRefreshBtn.addEventListener('click', () => current && loadDir());

  function renderBreadcrumb() {
    breadcrumb.innerHTML = '';
    const mk = (label, depth) => {
      const a = document.createElement('a');
      a.textContent = label;
      a.addEventListener('click', () => {
        current.path = current.path.slice(0, depth);
        loadDir();
      });
      breadcrumb.appendChild(a);
    };
    mk(current.share.name, 0);
    current.path.forEach((seg, i) => {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      breadcrumb.appendChild(sep);
      mk(seg, i + 1);
    });
  }

  async function loadDir() {
    const share = current.share;
    const token = tokens.get(share.id) || '';
    const pathStr = current.path.join('/');
    renderBreadcrumb();
    browserMeta.textContent = `${share.owner} 的共享${share.writable ? '（可写入）' : '（只读）'}`;
    browserRows.innerHTML = '';
    browserEmpty.hidden = true;
    browserLoading.hidden = false;
    let data;
    try {
      const r = await fetch(
        `/api/share/${encodeURIComponent(share.id)}/list?path=${encodeURIComponent(pathStr)}&token=${encodeURIComponent(token)}`
      );
      data = await r.json();
    } catch (_) {
      data = { ok: false, error: '网络错误' };
    }
    browserLoading.hidden = true;
    if (!data || !data.ok) {
      if (data && data.needAuth) {
        // token 失效（对方修改了密码等）→ 回列表并重新走进入流程
        tokens.delete(share.id);
        showShareHome();
        enterShare(shares.find((s) => s.id === share.id) || share);
        return;
      }
      setHint(shareBrowserHint, (data && data.error) || '目录加载失败', 'error');
      return;
    }
    setHint(shareBrowserHint, '');
    const entries = data.entries.slice().sort((a, b) => {
      if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-CN');
    });
    browserEmpty.hidden = entries.length > 0;
    for (const e of entries) {
      const tr = document.createElement('tr');
      tr.className = e.kind === 'dir' ? 'row-dir' : 'row-file';
      const fullPath = pathStr ? `${pathStr}/${e.name}` : e.name;
      if (e.kind === 'dir') {
        tr.innerHTML = `
          <td class="col-name"><span class="entry-icon dir">${ICON_DIR}</span><span class="entry-name">${escapeHtml(e.name)}</span></td>
          <td class="col-size">—</td>
          <td class="col-mtime">—</td>
          <td class="col-op"></td>`;
        tr.addEventListener('dblclick', () => { current.path.push(e.name); loadDir(); });
        tr.querySelector('.entry-name').addEventListener('click', () => { current.path.push(e.name); loadDir(); });
      } else {
        tr.innerHTML = `
          <td class="col-name"><span class="entry-icon file">${ICON_FILE}</span><span class="entry-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span></td>
          <td class="col-size">${fmtSize(e.size || 0)}</td>
          <td class="col-mtime">${fmtDate(e.mtime)}</td>
          <td class="col-op"><button class="download-btn small" type="button" data-act="dl" data-path="${escapeHtml(fullPath)}" data-name="${escapeHtml(e.name)}" data-size="${Number(e.size) || 0}">下载</button></td>`;
      }
      browserRows.appendChild(tr);
    }
  }

  // 文件行「下载」→ 分段断点续传（走 dl-core，可暂停/继续/刷新恢复）
  browserRows.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act="dl"]') : null;
    if (!btn || !current || !current.share) return;
    startDownload(current.share, btn.dataset.path, btn.dataset.name, Number(btn.dataset.size) || 0);
  });

  // ---------- 上传文件到共享目录 ----------
  shareUploadBtn.addEventListener('click', () => shareUploadInput.click());
  shareUploadInput.addEventListener('change', () => {
    if (shareUploadInput.files.length && current) {
      uploadToShare(shareUploadInput.files[0]);
      shareUploadInput.value = '';
    }
  });

  function uploadToShare(file) {
    const share = current.share;
    const token = tokens.get(share.id) || '';
    const target = current.path.concat([file.name]).join('/');
    setHint(shareBrowserHint, `正在上传 ${file.name} …`);
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `/api/share/${encodeURIComponent(share.id)}/write?path=${encodeURIComponent(target)}&token=${encodeURIComponent(token)}`
    );
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setHint(shareBrowserHint, `正在上传 ${file.name} … ${pct}%`);
      }
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status === 200 && data && data.ok) {
        setHint(shareBrowserHint, `已上传为 ${data.savedAs || file.name}`, 'success');
        loadDir();
      } else if (data && data.needAuth) {
        tokens.delete(share.id);
        showShareHome();
        enterShare(share);
      } else {
        setHint(shareBrowserHint, (data && data.error) || '上传失败', 'error');
      }
    };
    xhr.onerror = () => setHint(shareBrowserHint, '上传失败，请检查网络连接', 'error');
    xhr.send(file);
  }

  // ============================================================
  //  共享者本地代理：响应服务器的文件系统操作请求
  // ============================================================
  function myToken() {
    return myShare ? (tokens.get(myShare.id) || '') : '';
  }

  function splitPath(p) {
    return String(p || '').split('/').filter(Boolean);
  }

  // 文件名安全过滤（服务器已净化，这里双保险）
  function isSafeName(name) {
    if (!name || name === '.' || name === '..' || name.length > 255) return false;
    for (let i = 0; i < name.length; i++) {
      const c = name.charCodeAt(i);
      if (c < 32) return false;
    }
    return !/[\\/<>:"|?*]/.test(name);
  }

  function friendlyErr(err) {
    const name = err && err.name;
    if (name === 'NotFoundError') return '路径不存在';
    if (name === 'NotAllowedError') return '浏览器未授权该操作';
    if (name === 'TypeMismatchError') return '路径类型不符';
    return (err && err.message) || '操作失败';
  }

  async function resolveDir(parts) {
    let dir = myShare.dirHandle;
    for (const seg of parts) {
      if (!isSafeName(seg)) throw new Error('路径无效');
      dir = await dir.getDirectoryHandle(seg);
    }
    return dir;
  }

  async function localList(path) {
    const dir = await resolveDir(splitPath(path));
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        entries.push({ name, kind: 'dir' });
      } else {
        const f = await handle.getFile();
        entries.push({ name, kind: 'file', size: f.size, mtime: f.lastModified });
      }
    }
    return entries;
  }

  // 下载：先 ack 确认可读（含文件大小），再把文件内容 POST 推流给服务器中转。
  // Range 支持：req.range 存在时按 start/end 切片（断点续传/分段下载），服务器回 206。
  async function localRead(req, reply) {
    const parts = splitPath(req.path);
    const name = parts.pop();
    if (!isSafeName(name)) return reply({ ok: false, error: '路径无效' });
    let file;
    try {
      const dir = await resolveDir(parts);
      file = await (await dir.getFileHandle(name)).getFile();
    } catch (err) {
      return reply({ ok: false, error: friendlyErr(err) });
    }
    let slice = file;
    let start = 0;
    let hasRange = false;
    if (req.range) {
      hasRange = true;
      // 解析范围：bytes=-N 表示"最后 N 字节"（start 缺省），归一化为绝对 start..end
      let rs = req.range.start;
      let re = req.range.end;
      if (rs === null && re !== null) {
        rs = Math.max(0, file.size - re);
        re = null;
      }
      rs = rs == null ? 0 : rs;
      if (rs >= file.size) {
        return reply({ ok: false, rangeError: true, size: file.size, error: '超出文件范围' });
      }
      const end = re == null ? file.size - 1 : Math.min(re, file.size - 1);
      slice = file.slice(rs, end + 1);
      start = rs;
    }
    reply({ ok: true, size: file.size });
    // 推流失败无需再 ack（服务器侧有超时与断开清理）
    try {
      const url = `/api/share/${encodeURIComponent(myShare.id)}/push` +
        `?transferId=${encodeURIComponent(req.transferId)}` +
        `&token=${encodeURIComponent(myToken())}` +
        `&name=${encodeURIComponent(file.name)}&size=${slice.size}` +
        (hasRange ? `&start=${start}&total=${file.size}` : '');
      await fetch(url, { method: 'POST', body: slice });
    } catch (_) { /* 下载方已断开或网络错误 */ }
  }

  async function localFileExists(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch (err) {
      if (err && err.name === 'NotFoundError') return false;
      throw err;
    }
  }

  function withNumericSuffix(name, i) {
    const dot = name.lastIndexOf('.');
    if (dot > 0) return `${name.slice(0, dot)} (${i})${name.slice(dot)}`;
    return `${name} (${i})`;
  }

  // 上传：创建本地文件，从服务器拉流写入磁盘
  async function localWrite(req) {
    if (!myShare.canWrite) return { ok: false, error: '共享者未开启写入权限' };
    const parts = splitPath(req.path);
    const rawName = parts.pop();
    if (!isSafeName(rawName)) return { ok: false, error: '文件名无效' };
    let dir;
    try {
      dir = await resolveDir(parts);
    } catch (err) {
      return { ok: false, error: friendlyErr(err) };
    }
    // 重名自动追加 (1)、(2)…
    let finalName = rawName;
    for (let i = 1; i <= 100 && (await localFileExists(dir, finalName)); i++) {
      finalName = withNumericSuffix(rawName, i);
    }
    try {
      const fh = await dir.getFileHandle(finalName, { create: true });
      const writable = await fh.createWritable();
      const resp = await fetch(
        `/api/share/${encodeURIComponent(myShare.id)}/pull` +
        `?transferId=${encodeURIComponent(req.transferId)}` +
        `&token=${encodeURIComponent(myToken())}`
      );
      if (!resp.ok || !resp.body) return { ok: false, error: '拉取上传数据失败' };
      await resp.body.pipeTo(writable);
      return { ok: true, savedAs: finalName };
    } catch (err) {
      return { ok: false, error: friendlyErr(err) };
    }
  }

  socket.on('share_fs', async (req, reply) => {
    reply = typeof reply === 'function' ? reply : () => {};
    if (!myShare || !req) return reply({ ok: false, error: '共享已取消' });
    try {
      if (req.op === 'list') {
        reply({ ok: true, entries: await localList(req.path) });
      } else if (req.op === 'read') {
        await localRead(req, reply);
      } else if (req.op === 'write') {
        reply(await localWrite(req));
      } else {
        reply({ ok: false, error: '未知操作' });
      }
    } catch (err) {
      reply({ ok: false, error: friendlyErr(err) });
    }
  });

  // ---------- 初始化 ----------
  if (!fsSupported) {
    createShareBtn.title = '当前浏览器不支持，请使用 Chrome / Edge';
  }
  renderShares();
  // 刷新恢复：把 OPFS 里未完成的下载任务重新挂上并自动续传
  if (dlStorage) {
    downloader.restoreAll().then(() => renderDownloads()).catch(() => {});
  }
})();
