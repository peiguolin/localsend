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
  let myShare = null;            // { id, name, dirHandle, canWrite }
  const tokens = new Map();      // shareId -> 访问 token
  let current = null;            // 正在浏览的 { share, path: [seg, ...] }
  let pendingPwdShare = null;    // 正在输入密码的共享

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

  // ---------- 视图切换 ----------
  function switchView(view) {
    const isChat = view === 'chat';
    chatMain.hidden = !isChat;
    inputbar.hidden = !isChat;
    shareView.hidden = isChat;
    tabChat.classList.toggle('active', isChat);
    tabShare.classList.toggle('active', !isChat);
  }
  tabChat.addEventListener('click', () => switchView('chat'));
  tabShare.addEventListener('click', () => switchView('share'));

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
      myShare = { id: res.shareId, name, dirHandle: handle, canWrite };
      tokens.set(res.shareId, res.token);
      closeModal(createShareModal);
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
      closeModal(manageShareModal);
      renderShares();
      setHint(shareHomeHint, '共享设置已保存', 'success');
    });
  });

  function stopShare() {
    if (!myShare) return;
    socket.emit('share_unregister', { shareId: myShare.id }, () => {
      myShare = null;
      renderShares();
      setHint(shareHomeHint, '已取消共享', 'success');
    });
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
        const url = `/api/share/${encodeURIComponent(share.id)}/file?path=${encodeURIComponent(fullPath)}&token=${encodeURIComponent(token)}`;
        tr.innerHTML = `
          <td class="col-name"><span class="entry-icon file">${ICON_FILE}</span><span class="entry-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span></td>
          <td class="col-size">${fmtSize(e.size || 0)}</td>
          <td class="col-mtime">${fmtDate(e.mtime)}</td>
          <td class="col-op"><a class="download-btn small" href="${url}">下载</a></td>`;
      }
      browserRows.appendChild(tr);
    }
  }

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

  // 下载：先 ack 确认可读，再把文件内容 POST 推流给服务器中转
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
    reply({ ok: true });
    // 推流失败无需再 ack（服务器侧有超时与断开清理）
    try {
      const url = `/api/share/${encodeURIComponent(myShare.id)}/push` +
        `?transferId=${encodeURIComponent(req.transferId)}` +
        `&token=${encodeURIComponent(myToken())}` +
        `&name=${encodeURIComponent(file.name)}&size=${file.size}`;
      await fetch(url, { method: 'POST', body: file });
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
})();
