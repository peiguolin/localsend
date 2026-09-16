/* 上传分片：选图/文件 → 预览托盘（可配文字、可取消）→ 发送时分片上传（断点续传）。
 * 也支持粘贴截图、拖拽入托盘。双通道加载：Node 由 client.js require；浏览器 <script> 加载。
 * 跨模块依赖：壳的 setHint；chat 分片发送时经 app.sendAttachment(text) 取走托盘文件并附带配文。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const state = app.state;
  const { fmtSize, escapeHtml } = app.utils;

  // ---------- DOM 引用 ----------
  const fileInput = document.getElementById('fileInput');
  const chatArea = document.getElementById('chatArea');
  const groupModal = document.getElementById('groupModal');
  const tray = document.getElementById('attachTray');

  // ---------- 待发附件（MVP：单个；后续多图把它改成数组即可） ----------
  let pendingFile = null;
  let pendingUrl = null;
  let sending = false;

  function hasPendingAttachment() { return !!pendingFile; }

  function clearAttachment() {
    pendingFile = null;
    if (pendingUrl) { try { URL.revokeObjectURL(pendingUrl); } catch (_) {} pendingUrl = null; }
    tray.hidden = true;
    tray.innerHTML = '';
  }

  // 把文件放进托盘（图片显示缩略图，其它文件显示文件名/大小），不立即上传
  function queueFile(file) {
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) { app.setHint('文件超过 200MB 大小限制', 'error'); return; }
    if (file.size <= 0) { app.setHint('空文件无法发送', 'error'); return; }
    clearAttachment();
    pendingFile = file;
    const isImg = (file.type || '').indexOf('image/') === 0;
    if (isImg) pendingUrl = URL.createObjectURL(file);
    tray.innerHTML = `
      <div class="attach-item">
        ${isImg
          ? `<img class="attach-thumb" src="${pendingUrl}" alt="">`
          : `<span class="attach-fileicon">📄</span>`}
        <div class="attach-meta">
          <span class="attach-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="attach-size">${fmtSize(file.size)}</span>
        </div>
        <button class="attach-x" type="button" title="取消附件">×</button>
      </div>`;
    tray.hidden = false;
    tray.querySelector('.attach-x').addEventListener('click', clearAttachment);
    const input = document.getElementById('msgInput');
    if (input) input.focus();
  }

  // ---------- 分片上传（断点续传），caption 为可选文字说明 ----------
  function postJson(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then((r) => r.json().catch(() => ({ ok: false, error: '响应解析失败' })));
  }

  async function uploadFile(file, caption) {
    if (!file) return { ok: false };
    app.setHint(`正在上传 ${file.name} … 准备中`);
    try {
      // 1) 初始化（同一文件会返回已收分片 → 续传）
      const init = await postJson('/upload/init', {
        fileName: encodeURIComponent(file.name),
        size: file.size,
        lastModified: file.lastModified
      });
      if (!init || !init.ok) {
        app.setHint((init && init.error) || '初始化上传失败', 'error');
        return init || { ok: false };
      }
      const { uploadId, chunkSize, totalChunks, received } = init;
      const sentSet = new Set(received || []);
      const already = sentSet.size;

      // 2) 逐片上传未收分片
      for (let i = 0; i < totalChunks; i++) {
        if (sentSet.has(i)) continue;
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const blob = file.slice(start, end);
        const fd = new FormData();
        fd.append('file', blob, 'chunk.part');
        fd.append('uploadId', uploadId);
        fd.append('index', String(i));
        const res = await fetch('/upload/chunk', { method: 'POST', body: fd }).catch(() => null);
        if (!res || !res.ok) {
          app.setHint(`上传中断（第 ${i + 1}/${totalChunks} 片）。重新选择同一文件可断点续传`, 'error');
          return { ok: false };
        }
        const done = already + (i - sentSet.size + 1);
        app.setHint(`正在上传 ${file.name} … ${Math.round((done / totalChunks) * 100)}%`);
      }

      // 3) 合并 + 进聊天（带文字说明 caption）
      const fd2 = new FormData();
      fd2.append('uploadId', uploadId);
      fd2.append('originalName', encodeURIComponent(file.name));
      fd2.append('totalChunks', String(totalChunks));
      fd2.append('size', String(file.size));
      fd2.append('nickname', state.myNickname);
      fd2.append('clientId', state.myClientId);
      fd2.append('room', state.currentRoom);
      if (caption) fd2.append('text', caption);
      const comp = await fetch('/upload/complete', { method: 'POST', body: fd2 })
        .then((r) => r.json().catch(() => null)).catch(() => null);
      if (!comp || !comp.ok) {
        app.setHint((comp && comp.error) || '合并文件失败', 'error');
        return comp || { ok: false };
      }
      app.setHint(`已发送文件 ${file.name}`, 'success');
      return comp;
    } catch (e) {
      app.setHint(`上传失败：${e.message || '未知错误'}`, 'error');
      return { ok: false, error: e.message };
    }
  }

  // 供 chat 分片发送时调用：上传当前托盘附件（带配文），成功后清空托盘
  async function sendAttachment(caption) {
    if (!pendingFile || sending) return { ok: false };
    sending = true;
    try {
      const file = pendingFile;
      const res = await uploadFile(file, String(caption || '').trim());
      if (res && res.ok) clearAttachment();
      return res;
    } finally {
      sending = false;
    }
  }

  // 点击选择文件 → 入托盘（不再立即发送）
  document.querySelector('.file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      queueFile(fileInput.files[0]);
      fileInput.value = '';
    }
  });

  // ---------- 粘贴截图：入托盘（纯文本粘贴不拦截；群聊弹窗打开时不接管） ----------
  // Linux（Wayland / 部分截图工具）paste 事件常读不到图片项，兜底用 navigator.clipboard.read()。
  function pastedImageName(type) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    const ext = String(type || 'image/png').split('/')[1] || 'png';
    return `粘贴图片-${stamp}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`;
  }
  async function readClipboardImageFallback() {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') return null;
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imgType = (item.types || []).find((t) => t.indexOf('image/') === 0);
        if (imgType) return await item.getType(imgType);
      }
    } catch (_) { /* 无权限/被拒绝/不支持：返回 null */ }
    return null;
  }
  document.addEventListener('paste', (e) => {
    if (groupModal && !groupModal.hidden) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
          e.preventDefault();
          const blob = item.getAsFile && item.getAsFile();
          if (blob) {
            queueFile(new File([blob], pastedImageName(item.type), { type: item.type, lastModified: Date.now() }));
            return;
          }
        }
      }
    }
    // 兜底：items 没读到图片（Linux 常见）→ Clipboard API 异步重读
    readClipboardImageFallback().then((blob) => {
      if (blob) {
        queueFile(new File([blob], pastedImageName(blob.type), { type: blob.type, lastModified: Date.now() }));
        return;
      }
      if (items) {
        const fileItems = Array.from(items).filter((it) => it.kind === 'file');
        if (fileItems.length) {
          const types = fileItems.map((it) => it.type || '(无类型)').join(' / ');
          console.warn('[粘贴] 剪贴板有文件但未识别为图片:', types);
          app.setHint('剪贴板内容浏览器无法读取为图片，可试试用「文件」选择图片', 'error');
        }
      }
    });
  });

  // 拖拽：拖到聊天区高亮，松手入托盘
  ['dragenter', 'dragover'].forEach((evt) => {
    chatArea.addEventListener(evt, (e) => {
      e.preventDefault();
      chatArea.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    chatArea.addEventListener(evt, (e) => {
      e.preventDefault();
      chatArea.classList.remove('dragover');
    });
  });
  chatArea.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) queueFile(files[0]);
  });

  // 暴露给 chat 分片（发送）与 rooms 分片（切房时清托盘，防发错房间）
  Object.assign(app, {
    hasPendingAttachment,
    sendAttachment,
    clearAttachment
  });
})();
