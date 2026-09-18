/* share 文件浏览器片：进入共享后的目录浏览、面包屑、文件下载（走下载管理器）、上传到共享目录。
 * 跨片经内部总线 S（app._share）：S.openBrowser 供核心片密码通过后调用。 */
(function () {
  'use strict';
  if (!window.chatApp) return;
  const app = window.chatApp;
  const S = app._share;
  const { escapeHtml, fmtSize } = app.utils;
  const el = S.el;

  function openBrowser(share) {
    S.current = { share, path: [] };
    el.shareHome.hidden = true;
    el.shareBrowser.hidden = false;
    el.shareUploadBtn.hidden = !share.writable;
    loadDir();
  }
  S.openBrowser = openBrowser;

  el.browserBackBtn.addEventListener('click', () => S.showShareHome());
  el.browserRefreshBtn.addEventListener('click', () => S.current && loadDir());

  function renderBreadcrumb() {
    el.breadcrumb.innerHTML = '';
    const mk = (label, depth) => {
      const a = document.createElement('a');
      a.textContent = label;
      a.addEventListener('click', () => {
        S.current.path = S.current.path.slice(0, depth);
        loadDir();
      });
      el.breadcrumb.appendChild(a);
    };
    mk(S.current.share.name, 0);
    S.current.path.forEach((seg, i) => {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      el.breadcrumb.appendChild(sep);
      mk(seg, i + 1);
    });
  }

  async function loadDir() {
    const share = S.current.share;
    const token = S.tokens.get(share.id) || '';
    const pathStr = S.current.path.join('/');
    renderBreadcrumb();
    el.browserMeta.textContent = `${share.owner} 的共享${share.writable ? '（可写入）' : '（只读）'}`;
    el.browserRows.innerHTML = '';
    el.browserEmpty.hidden = true;
    el.browserLoading.hidden = false;
    let data;
    try {
      const r = await fetch(
        `/api/share/${encodeURIComponent(share.id)}/list?path=${encodeURIComponent(pathStr)}&token=${encodeURIComponent(token)}`
      );
      data = await r.json();
    } catch (_) {
      data = { ok: false, error: '网络错误' };
    }
    el.browserLoading.hidden = true;
    if (!data || !data.ok) {
      if (data && data.needAuth) {
        // token 失效（对方改密码等）→ 回列表重新走进入流程
        S.tokens.delete(share.id);
        S.showShareHome();
        S.enterShare(S.shares.find((s) => s.id === share.id) || share);
        return;
      }
      S.setHint(el.shareBrowserHint, (data && data.error) || '目录加载失败', 'error');
      return;
    }
    S.setHint(el.shareBrowserHint, '');
    const entries = data.entries.slice().sort((a, b) => {
      if ((a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-CN');
    });
    el.browserEmpty.hidden = entries.length > 0;
    for (const e of entries) {
      const tr = document.createElement('tr');
      tr.className = e.kind === 'dir' ? 'row-dir' : 'row-file';
      const fullPath = pathStr ? `${pathStr}/${e.name}` : e.name;
      if (e.kind === 'dir') {
        tr.innerHTML = `
          <td class="col-name"><span class="entry-icon dir">${S.ICON_DIR}</span><span class="entry-name">${escapeHtml(e.name)}</span></td>
          <td class="col-size">—</td>
          <td class="col-mtime">—</td>
          <td class="col-op"></td>`;
        tr.addEventListener('dblclick', () => { S.current.path.push(e.name); loadDir(); });
        tr.querySelector('.entry-name').addEventListener('click', () => { S.current.path.push(e.name); loadDir(); });
      } else {
        tr.innerHTML = `
          <td class="col-name"><span class="entry-icon file">${S.ICON_FILE}</span><span class="entry-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span></td>
          <td class="col-size">${fmtSize(e.size || 0)}</td>
          <td class="col-mtime">${S.fmtDate(e.mtime)}</td>
          <td class="col-op"><button class="download-btn small" type="button" data-act="dl" data-path="${escapeHtml(fullPath)}" data-name="${escapeHtml(e.name)}" data-size="${Number(e.size) || 0}">下载</button></td>`;
      }
      el.browserRows.appendChild(tr);
    }
  }
  S.loadDir = loadDir;

  // 文件行「下载」→ 分段断点续传（下载管理器，可暂停/继续/刷新恢复）
  el.browserRows.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act="dl"]') : null;
    if (!btn || !S.current || !S.current.share) return;
    startDownload(S.current.share, btn.dataset.path, btn.dataset.name, Number(btn.dataset.size) || 0);
  });

  function startDownload(share, fullPath, name, size) {
    const token = S.tokens.get(share.id) || '';
    const url = `/api/share/${encodeURIComponent(share.id)}/file?path=${encodeURIComponent(fullPath)}&token=${encodeURIComponent(token)}`;
    const key = `${share.id}:${fullPath}`;
    S.downloader.newDownload({ key, url, name, size });
    S.renderDownloads();
    S.downloader.resume(key);
    S.setHint(el.shareBrowserHint, `开始下载 ${name}`, 'success');
  }

  // ---------- 上传文件到共享目录 ----------
  el.shareUploadBtn.addEventListener('click', () => el.shareUploadInput.click());
  el.shareUploadInput.addEventListener('change', () => {
    if (el.shareUploadInput.files.length && S.current) {
      uploadToShare(el.shareUploadInput.files[0]);
      el.shareUploadInput.value = '';
    }
  });

  function uploadToShare(file) {
    const share = S.current.share;
    const token = S.tokens.get(share.id) || '';
    const target = S.current.path.concat([file.name]).join('/');
    S.setHint(el.shareBrowserHint, `正在上传 ${file.name} …`);
    const xhr = new XMLHttpRequest();
    xhr.open(
      'POST',
      `/api/share/${encodeURIComponent(share.id)}/write?path=${encodeURIComponent(target)}&token=${encodeURIComponent(token)}`
    );
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        S.setHint(el.shareBrowserHint, `正在上传 ${file.name} … ${pct}%`);
      }
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 200 && data && data.ok) {
        S.setHint(el.shareBrowserHint, `已上传为 ${data.savedAs || file.name}`, 'success');
        loadDir();
      } else if (data && data.needAuth) {
        S.tokens.delete(share.id);
        S.showShareHome();
        S.enterShare(share);
      } else {
        S.setHint(el.shareBrowserHint, (data && data.error) || '上传失败', 'error');
      }
    };
    xhr.onerror = () => S.setHint(el.shareBrowserHint, '上传失败，请检查网络连接', 'error');
    xhr.send(file);
  }
})();
