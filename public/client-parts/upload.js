/* 上传分片：分片上传（断点续传）/ 粘贴截图即发 / 拖拽上传。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之后加载。
 * 跨模块依赖：壳的 setHint；DOM 读取 rooms 的 groupModal（仅判断弹窗是否打开，避免误发）。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const state = app.state;

  // ---------- DOM 引用 ----------
  const fileInput = document.getElementById('fileInput');
  const chatArea = document.getElementById('chatArea');
  const groupModal = document.getElementById('groupModal');

  // ---------- 文件上传（分片 + 断点续传） ----------
  // 上传中断/刷新后重新选择同一文件：init 返回已收分片，自动跳过续传
  function postJson(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then((r) => r.json().catch(() => ({ ok: false, error: '响应解析失败' })));
  }

  async function uploadFile(file) {
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) {
      app.setHint('文件超过 200MB 大小限制', 'error');
      return;
    }
    if (file.size <= 0) {
      app.setHint('空文件无法上传', 'error');
      return;
    }
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
        return;
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
          return;
        }
        const done = already + (i - sentSet.size + 1);
        app.setHint(`正在上传 ${file.name} … ${Math.round((done / totalChunks) * 100)}%`);
      }

      // 3) 合并 + 进聊天
      const fd2 = new FormData();
      fd2.append('uploadId', uploadId);
      fd2.append('originalName', encodeURIComponent(file.name));
      fd2.append('totalChunks', String(totalChunks));
      fd2.append('size', String(file.size));
      fd2.append('nickname', state.myNickname);
      fd2.append('clientId', state.myClientId);
      fd2.append('room', state.currentRoom);
      const comp = await fetch('/upload/complete', { method: 'POST', body: fd2 })
        .then((r) => r.json().catch(() => null)).catch(() => null);
      if (!comp || !comp.ok) {
        app.setHint((comp && comp.error) || '合并文件失败', 'error');
        return;
      }
      app.setHint(`已发送文件 ${file.name}`, 'success');
    } catch (e) {
      app.setHint(`上传失败：${e.message || '未知错误'}`, 'error');
    }
  }

  // 点击选择文件
  document.querySelector('.file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      uploadFile(fileInput.files[0]);
      fileInput.value = '';
    }
  });

  // ---------- 粘贴截图即发送（方案 A：桌面端） ----------
  // 剪贴板含图片时接管并直接发送；纯文本粘贴不受影响（不 preventDefault）；
  // 群聊弹窗打开时不接管，避免误发。
  // 注意：Linux（Wayland / 部分截图工具）下 paste 事件的 clipboardData.items
  // 常常读不到图片项（Chromium 的 Linux 剪贴板映射问题，微信等原生应用不受影响），
  // 因此兜底用 navigator.clipboard.read() 直接读剪贴板图片（HTTPS 可用，首次请求授权）。
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
    } catch (_) { /* 无权限/被拒绝/不支持：返回 null 走诊断 */ }
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
            uploadFile(new File([blob], pastedImageName(item.type), { type: item.type, lastModified: Date.now() }));
            return;
          }
        }
      }
    }
    // 兜底：items 里没读到图片（Linux 常见）→ 用 Clipboard API 异步重读
    readClipboardImageFallback().then((blob) => {
      if (blob) {
        uploadFile(new File([blob], pastedImageName(blob.type), { type: blob.type, lastModified: Date.now() }));
        return;
      }
      // 诊断：剪贴板确实有文件类内容但都读不到图片，提示用户（帮助排查 Linux 剪贴板问题）
      if (items) {
        const fileItems = Array.from(items).filter((it) => it.kind === 'file');
        if (fileItems.length) {
          const types = fileItems.map((it) => it.type || '(无类型)').join(' / ');
          console.warn('[粘贴] 剪贴板有文件但未识别为图片:', types);
          app.setHint('剪贴板内容浏览器无法读取为图片，可试试：菜单-设置-检查剪贴板权限，或用「+」选择图片', 'error');
        }
      }
    });
  });

  // 拖拽上传（拖到聊天区）
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
    if (files && files.length) {
      uploadFile(files[0]);
    }
  });
})();
