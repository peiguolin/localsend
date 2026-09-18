/* share 下载管理片：OPFS 分段存储 + SegmentDownloader 接线 + 下载列表 UI（暂停/继续/取消/另存）。
 * 下载器挂到总线 S.downloader，供文件浏览器片发起；刷新后恢复未完成任务。 */
(function () {
  'use strict';
  if (!window.chatApp) return;
  const app = window.chatApp;
  const S = app._share;
  const { escapeHtml, fmtSize } = app.utils;
  const el = S.el;

  // OPFS：段数据写 OPFS，刷新后 restoreAll 续传（已下段不重下）；不支持则内存降级
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
  const downloader = new app.dlCore.SegmentDownloader({
    storage: dlStorage,
    onProgress: renderDownloads,
    onState: renderDownloads,
    onDone: (h) => { renderDownloads(); S.setHint(el.shareBrowserHint, `「${h.name}」下载完成`, 'success'); },
    onError: (h) => { renderDownloads(); S.setHint(el.shareBrowserHint, `「${h.name}」下载失败：${h.error}`, 'error'); }
  });
  S.downloader = downloader;

  const DL_STATUS = { idle: '等待', downloading: '下载中', paused: '已暂停', done: '已完成', error: '失败', cancelled: '已取消' };
  const fmtPct = (h) => (h.size ? Math.min(100, Math.round((h.doneBytes / h.size) * 100)) : 0);

  function renderDownloads() {
    const list = downloader.all();
    el.dlManager.hidden = list.length === 0;
    el.dlEmpty.hidden = list.length > 0;
    el.dlList.innerHTML = list.map((h) => {
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
  S.renderDownloads = renderDownloads;

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

  el.dlList.addEventListener('click', (e) => {
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

  // 刷新恢复：把 OPFS 里未完成的下载任务重新挂上并自动续传
  if (dlStorage) {
    downloader.restoreAll().then(() => renderDownloads()).catch(() => {});
  }
})();
