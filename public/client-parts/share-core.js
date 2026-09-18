/* share 核心 UI 片：Tab 注册、共享列表渲染、创建/管理/取消共享、句柄持久化恢复、密码进入。
 * 跨片经内部总线 S（app._share）共享状态与 DOM；文件浏览器/本地代理在另外两片。 */
(function () {
  'use strict';
  if (!window.chatApp) return;
  const app = window.chatApp;
  const S = app._share;
  const socket = app.socket;
  const { escapeHtml } = app.utils;
  const el = S.el;
  const shareStore = app.shareStore || null;

  // ---------- Tab 注册（whiteboard 等也复用同一注册制） ----------
  const tabRegistry = new Map();
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
  registerTab('chat', el.tabChat, [el.chatMain, el.inputbar]);
  registerTab('share', el.tabShare, [el.shareView]);
  app.switchView = switchView;
  app.registerTab = registerTab;

  // 回共享首页（browser 片会挂 S.showShareHome 的浏览区收尾逻辑，这里只切主页可见性）
  function showShareHome() {
    S.current = null;
    el.shareBrowser.hidden = true;
    el.shareHome.hidden = false;
    renderShares();
  }
  S.showShareHome = showShareHome;

  // ---------- 共享列表 ----------
  function renderShares() {
    // 我的共享盒子
    if (S.myShare) {
      const info = S.shares.find((s) => s.id === S.myShare.id);
      el.myShareBox.hidden = false;
      el.myShareBox.innerHTML = `
        <div class="my-share-info">
          <span class="share-icon owner">${S.ICON_DIR}</span>
          <div class="share-names">
            <div class="share-name">${escapeHtml(S.myShare.name)} <span class="tag tag-me">我的共享</span></div>
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
      el.myShareBox.hidden = true;
      el.myShareBox.innerHTML = '';
    }

    el.shareList.innerHTML = '';
    el.shareEmpty.hidden = S.shares.length > 0;
    const sorted = S.shares.slice().sort((a, b) => a.createdAt - b.createdAt);
    for (const s of sorted) {
      const isMine = S.myShare && s.id === S.myShare.id;
      const li = document.createElement('li');
      li.className = 'share-item';
      li.innerHTML = `
        <span class="share-icon">${S.ICON_DIR}</span>
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
      el.shareList.appendChild(li);
    }
  }
  S.renderShares = renderShares;

  socket.on('shares_update', (list) => {
    S.shares = Array.isArray(list) ? list : [];
    if (S.myShare && !S.shares.some((s) => s.id === S.myShare.id)) {
      S.myShare = null;
      if (S.current && !S.shares.some((s) => s.id === S.current.share.id)) showShareHome();
    }
    if (S.current && !S.shares.some((s) => s.id === S.current.share.id)) {
      showShareHome();
      S.setHint(el.shareHomeHint, '该共享已被对方关闭', 'error');
    }
    renderShares();
  });

  socket.on('connect', () => {
    if (S.myShare) {
      S.myShare = null;
      S.setHint(el.shareHomeHint, '连接已断开重连，如需继续共享请重新创建', 'error');
    }
    S.tokens.clear();
    if (S.current) {
      const s = S.shares.find((x) => x.id === S.current.share.id);
      if (s) enterShare(s);
      else showShareHome();
    }
    renderShares();
    tryRestoreShare();
  });

  // ---------- 创建 / 管理 / 取消共享 ----------
  el.createShareBtn.addEventListener('click', () => {
    if (S.myShare) { S.setHint(el.shareHomeHint, '你已有共享中的文件夹，请先取消', 'error'); return; }
    if (!S.fsSupported) {
      S.setHint(el.shareHomeHint, '当前浏览器不支持共享文件夹，请使用 Chrome / Edge', 'error');
      return;
    }
    el.csName.value = '';
    el.csPassword.value = '';
    el.csWritable.checked = false;
    el.csTip.classList.remove('error');
    el.csTip.textContent = '确认后会弹出系统文件夹选择器，选择要共享的文件夹（需 Chrome / Edge，共享期间本页面需保持打开）';
    S.openModal(el.createShareModal);
  });

  el.csCancel.addEventListener('click', () => S.closeModal(el.createShareModal));

  el.csConfirm.addEventListener('click', async () => {
    const wantWrite = el.csWritable.checked;
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: wantWrite ? 'readwrite' : 'read' });
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        el.csTip.classList.add('error');
        el.csTip.textContent = '无法打开文件夹选择器：' + (e.message || e);
      }
      return;
    }
    let canWrite = false;
    if (wantWrite) {
      try { canWrite = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch (_) { canWrite = false; }
    }
    const name = el.csName.value.trim() || handle.name;
    const password = el.csPassword.value || '';
    el.csConfirm.disabled = true;
    socket.emit('share_register', {
      name, password: password || null, writable: canWrite
    }, (res) => {
      el.csConfirm.disabled = false;
      if (!res || !res.ok) {
        el.csTip.classList.add('error');
        el.csTip.textContent = (res && res.error) || '创建共享失败';
        return;
      }
      S.myShare = { id: res.shareId, name, dirHandle: handle, canWrite, password: password || null };
      S.tokens.set(res.shareId, res.token);
      S.closeModal(el.createShareModal);
      if (shareStore) shareStore.save({ name, password: password || null, writable: canWrite, handle }).catch(() => {});
      const restoreBox = document.getElementById('restoreShareBox');
      if (restoreBox) restoreBox.hidden = true;
      renderShares();
      S.setHint(el.shareHomeHint,
        wantWrite && !canWrite ? '已开始共享（未获得写入授权，当前为只读共享）' : `已开始共享「${name}」`,
        'success');
    });
  });

  function openManageModal() {
    if (!S.myShare) return;
    const info = S.shares.find((s) => s.id === S.myShare.id);
    el.msName.value = S.myShare.name;
    el.msPassword.value = '';
    el.msClearPassword.checked = false;
    el.msWritable.checked = !!(info && info.writable);
    el.msWritable.disabled = !S.myShare.canWrite;
    el.msTip.textContent = S.myShare.canWrite
      ? '修改密码后，已访问的其他成员需要重新输入密码'
      : '创建共享时未获得写入授权，无法开启写入；修改密码后其他成员需要重新输入密码';
    S.openModal(el.manageShareModal);
  }

  el.msCancel.addEventListener('click', () => S.closeModal(el.manageShareModal));

  el.msConfirm.addEventListener('click', () => {
    if (!S.myShare) return;
    const payload = { shareId: S.myShare.id, name: el.msName.value, writable: el.msWritable.checked && S.myShare.canWrite };
    if (el.msClearPassword.checked) payload.password = null;
    else if (el.msPassword.value) payload.password = el.msPassword.value;
    el.msConfirm.disabled = true;
    socket.emit('share_update', payload, (res) => {
      el.msConfirm.disabled = false;
      if (!res || !res.ok) { el.msTip.textContent = (res && res.error) || '保存失败'; return; }
      S.myShare.name = res.share.name;
      if (payload.password === null) S.myShare.password = null;
      else if (payload.password) S.myShare.password = payload.password;
      S.closeModal(el.manageShareModal);
      if (shareStore && S.myShare.dirHandle) {
        shareStore.save({ name: S.myShare.name, password: S.myShare.password, writable: S.myShare.canWrite, handle: S.myShare.dirHandle }).catch(() => {});
      }
      renderShares();
      S.setHint(el.shareHomeHint, '共享设置已保存', 'success');
    });
  });

  function stopShare() {
    if (!S.myShare) return;
    socket.emit('share_unregister', { shareId: S.myShare.id }, () => {
      S.myShare = null;
      if (shareStore) shareStore.clear().catch(() => {});
      renderShares();
      S.setHint(el.shareHomeHint, '已取消共享', 'success');
    });
  }

  // ---------- 句柄持久化恢复 ----------
  function doRestore(rec) {
    if (!shareStore) return;
    socket.emit('share_register', { name: rec.name, password: rec.password || null, writable: !!rec.writable }, (res) => {
      if (res && res.ok) {
        S.myShare = { id: res.shareId, name: rec.name || res.name || '恢复的共享', dirHandle: rec.handle, canWrite: !!rec.writable, password: rec.password || null };
        S.tokens.set(res.shareId, res.token);
        renderShares();
        S.setHint(el.shareHomeHint, `已自动恢复共享「${S.myShare.name}」`, 'success');
      } else {
        S.setHint(el.shareHomeHint, (res && res.error) || '恢复共享失败', 'error');
      }
    });
  }

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
        S.setHint(el.shareHomeHint, '未获得该文件夹的访问授权，无法恢复共享', 'error');
      }
    });
  }

  function tryRestoreShare() {
    if (S.myShare || !shareStore || !shareStore.isSupported) return;
    shareStore.load().then((rec) => {
      if (!rec || !rec.handle) return;
      shareStore.queryPermission(rec.handle, !!rec.writable).then((perm) => {
        if (perm === 'granted') doRestore(rec);
        else if (perm === 'prompt') showRestoreBar(rec);
      }).catch(() => {});
    }).catch(() => {});
  }
  S.tryRestoreShare = tryRestoreShare;

  // ---------- 进入共享（密码校验；打开浏览器由 browser 片提供 S.openBrowser） ----------
  function enterShare(share, password) {
    socket.emit('share_enter', { shareId: share.id, password }, (res) => {
      if (res && res.ok) {
        S.tokens.set(share.id, res.token);
        S.closeModal(el.pwdModal);
        S.openBrowser(res.share || share);
      } else if (res && res.needPassword) {
        S.pendingPwdShare = share;
        el.pwdTitle.textContent = `「${share.name}」需要访问密码`;
        el.pwdError.hidden = !res.error || res.error === '该共享需要密码';
        el.pwdError.textContent = res.error || '';
        el.pwdInput.value = '';
        S.openModal(el.pwdModal);
        el.pwdInput.focus();
      } else {
        S.setHint(el.shareHomeHint, (res && res.error) || '进入共享失败', 'error');
      }
    });
  }
  S.enterShare = enterShare;

  el.pwdConfirm.addEventListener('click', () => { if (S.pendingPwdShare) enterShare(S.pendingPwdShare, el.pwdInput.value); });
  el.pwdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && S.pendingPwdShare) enterShare(S.pendingPwdShare, el.pwdInput.value); });
  el.pwdCancel.addEventListener('click', () => { S.pendingPwdShare = null; S.closeModal(el.pwdModal); });

  // 弹窗背景关闭 / Esc
  [el.createShareModal, el.pwdModal, el.manageShareModal].forEach((m) => {
    if (m && m.querySelector) m.querySelector('.modal-backdrop').addEventListener('click', () => S.closeModal(m));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    [el.createShareModal, el.pwdModal, el.manageShareModal].forEach((m) => S.closeModal(m));
  });

  // 初始化
  if (!S.fsSupported) el.createShareBtn.title = '当前浏览器不支持，请使用 Chrome / Edge';
  renderShares();
})();
