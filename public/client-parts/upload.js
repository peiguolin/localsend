/* 上传队列：多文件待发托盘（可逐项取消/重试），发送时分片上传（断点续传 + 失败自动重试）。
 * 也支持粘贴截图、拖拽入托盘。双通道加载：Node 由 client.js require；浏览器 <script> 加载。
 * 跨模块依赖：壳的 setHint；chat 分片发送时经 app.sendAttachment(text) 取走整个队列。
 * 队列模型：queue = [{file, name, size, isImg, thumbUrl, caption, status, progress, error, uploadId, controller}]
 *   status: pending → hashing → uploading → done | error | cancelled
 * 发送语义：单文件 + 配文 → 图文同发（配文附着在该文件消息上）；多文件 + 配文 → 配文作为独立文字消息先发；无配文 → 文件各自独立。
 */
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

  // ---------- 上传队列 ----------
  const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 单文件上限 2GB（与服务器默认一致；服务器可在配置面板调整）
  const CONCURRENCY = 2;                     // 同时上传的文件数
  const MAX_ATTEMPTS = 3;                    // 每个文件的自动重试次数（重试 = 断点续传）
  const queue = [];
  let sending = false;
  const activeJobs = new Set();              // 正在跑的任务（取消后仍保留引用，便于中断）

  function hasPendingAttachment() { return queue.length > 0; }

  function clearAttachment() {
    for (const job of queue.slice()) {
      job.cancelled = true;
      if (job.controller) { try { job.controller.abort(); } catch (_) {} }
      if (job.uploadId) postJson('/upload/abort', { uploadId: job.uploadId }).catch(() => {});
      if (job.thumbUrl) { try { URL.revokeObjectURL(job.thumbUrl); } catch (_) {} }
    }
    queue.length = 0;
    tray.hidden = true;
    tray.innerHTML = '';
  }

  // 把文件放进队列（图片显示缩略图，其它文件显示文件名/大小），不立即上传
  function queueFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) { app.setHint('文件超过 2GB 大小限制', 'error'); return; }
    if (file.size <= 0) { app.setHint('空文件无法发送', 'error'); return; }
    const isImg = (file.type || '').indexOf('image/') === 0;
    queue.push({
      file, name: file.name, size: file.size, isImg,
      thumbUrl: isImg ? URL.createObjectURL(file) : null,
      caption: '', status: 'pending', progress: 0, error: '',
      uploadId: null, controller: null, cancelled: false
    });
    renderTray();
    const input = document.getElementById('msgInput');
    if (input) input.focus();
  }

  const STATUS_TEXT = {
    pending: '等待发送', hashing: '计算校验…', uploading: '上传中', done: '已发送', error: '发送失败'
  };

  function jobRowHTML(job, idx) {
    const pct = job.status === 'done' ? 100 : Math.max(0, Math.min(99, Math.round(job.progress * 100)));
    const statusText = job.status === 'uploading' ? `${STATUS_TEXT.uploading} ${pct}%` : STATUS_TEXT[job.status] || job.status;
    return `
      <div class="attach-item">
        ${job.isImg
          ? `<img class="attach-thumb" src="${job.thumbUrl || ''}" alt="">`
          : `<span class="attach-fileicon">📄</span>`}
        <div class="attach-meta">
          <span class="attach-name" title="${escapeHtml(job.name)}">${escapeHtml(job.name)}</span>
          <span class="attach-size">${fmtSize(job.size)}</span>
          <span class="attach-status${job.status === 'error' ? ' error' : ''}" data-status>${escapeHtml(job.error ? (statusText + '：' + job.error) : statusText)}</span>
          ${job.status === 'pending' || job.status === 'hashing' || job.status === 'uploading' ? `
            <span class="attach-progress"><span class="attach-progress-bar" style="width:${pct}%"></span></span>` : ''}
        </div>
        <span class="attach-ops">
          ${job.status === 'error'
            ? `<button type="button" class="attach-retry" data-act="retry" data-idx="${idx}" title="重试（断点续传）">↻ 重试</button>`
            : job.status === 'done' ? '' : `<button type="button" class="attach-x" data-act="cancel" data-idx="${idx}" title="取消">×</button>`}
        </span>
      </div>`;
  }

  function renderTray() {
    tray.innerHTML = queue.map(jobRowHTML).join('');
    tray.hidden = queue.length === 0;
  }

  // 事件委托：取消 / 重试（真实浏览器；冒烟测试桩 DOM 不触发点击）
  tray.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    e.stopPropagation();
    const idx = Number(btn.dataset.idx);
    const job = queue[idx];
    if (!job) return;
    if (btn.dataset.act === 'cancel') cancelJob(job);
    else if (btn.dataset.act === 'retry') retryJob(job);
  });

  function cancelJob(job) {
    job.cancelled = true;
    if (job.controller) { try { job.controller.abort(); } catch (_) {} }
    if (job.uploadId) postJson('/upload/abort', { uploadId: job.uploadId }).catch(() => {});
    if (job.thumbUrl) { try { URL.revokeObjectURL(job.thumbUrl); } catch (_) {} }
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    renderTray();
  }

  function retryJob(job) {
    job.status = 'pending';
    job.progress = 0;
    job.error = '';
    job.uploadId = null;
    renderTray();
    uploadOne(job).then((r) => {
      if (r && r.ok) {
        // 重试成功 = 已发送 → 移出队列，避免再次发送造成重复
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        renderTray();
        app.setHint(`已重发 ${job.name}`, 'success');
      }
    });
  }

  // ---------- 分片上传（断点续传 + 自动重试），caption 为可选文字说明 ----------
  function postJson(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then((r) => r.json().catch(() => ({ ok: false, error: '响应解析失败' })));
  }

  // 计算文件内容 sha256（秒传去重用；crypto.subtle 不可用/失败时返回 null 走普通上传）
  async function fileSha256(file) {
    try {
      if (!file || typeof file.arrayBuffer !== 'function' || !window.crypto || !window.crypto.subtle) return null;
      const CHUNK = 4 * 1024 * 1024;
      const buf = new Uint8Array(file.size);
      let off = 0;
      for (let i = 0; i < file.size; i += CHUNK) {
        const part = new Uint8Array(await file.slice(i, Math.min(i + CHUNK, file.size)).arrayBuffer());
        buf.set(part, off);
        off += part.length;
      }
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return null;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 取消时主动清理服务端临时分片
  async function abortTmp(job) {
    if (job.uploadId) {
      postJson('/upload/abort', { uploadId: job.uploadId }).catch(() => {});
      job.uploadId = null;
    }
  }

  // 上传单个文件：哈希 → init（可重试）→ 分片（失败重试=重新 init 拿 received 续传）→ complete
  async function uploadOne(job) {
    activeJobs.add(job);
    try {
      if (job.cancelled) return { ok: false, cancelled: true };
      job.status = 'hashing';
      job.progress = 0.02;
      job.error = '';
      renderTray();

      const sha256 = await fileSha256(job.file);
      if (job.cancelled) { await abortTmp(job); return { ok: false, cancelled: true }; }

      // 秒传：init 命中已存文件 → 直接走 complete 的 dedup 分支
      const initBody = { fileName: job.name, size: job.size, lastModified: job.file.lastModified || 0 };
      if (sha256) initBody.sha256 = sha256;

      let init = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        init = await postJson('/upload/init', initBody);
        if (init && init.ok) break;
        if (job.cancelled) return { ok: false, cancelled: true };
        if (attempt < MAX_ATTEMPTS) await sleep(400 * attempt);
      }
      if (!init || !init.ok) {
        job.status = 'error';
        job.error = (init && init.error) || '初始化上传失败';
        renderTray();
        return { ok: false, error: job.error };
      }

      if (init.dedup) {
        job.status = 'uploading';
        job.progress = 0.9;
        renderTray();
        const comp = await completeUpload(job, sha256, true, init.storedName);
        if (job.cancelled) return { ok: false, cancelled: true };
        if (comp && comp.ok) {
          job.status = 'done'; job.progress = 1; job.uploadId = null;
          renderTray();
          return comp;
        }
        job.status = 'error';
        job.error = (comp && comp.error) || '秒传失败';
        renderTray();
        return { ok: false, error: job.error };
      }

      job.uploadId = init.uploadId;
      job.controller = new AbortController();
      const totalChunks = Number(init.totalChunks) || 0;
      const received = new Set((init.received || []).map(Number));
      let chunkIndex = 0;
      let attempt = 1;
      job.status = 'uploading';
      renderTray();

      while (chunkIndex < totalChunks) {
        if (job.cancelled) { await abortTmp(job); return { ok: false, cancelled: true }; }
        const index = chunkIndex;
        if (received.has(index)) { chunkIndex++; continue; }
        const start = index * init.chunkSize;
        const end = Math.min(job.file.size, start + init.chunkSize);
        const blob = job.file.slice(start, end);
        const fd = new FormData();
        fd.append('uploadId', job.uploadId);
        fd.append('index', String(index));
        fd.append('file', blob, job.name);
        let res = null;
        try {
          res = await fetch('/upload/chunk', { method: 'POST', body: fd, signal: job.controller.signal });
        } catch (err) {
          if (job.cancelled) { await abortTmp(job); return { ok: false, cancelled: true }; }
          if (attempt >= MAX_ATTEMPTS) {
            job.status = 'error';
            job.error = String((err && err.message) || err);
            await abortTmp(job);
            renderTray();
            return { ok: false, error: job.error };
          }
          attempt++;
          await sleep(400 * attempt);
          continue;
        }
        if (job.cancelled) { await abortTmp(job); return { ok: false, cancelled: true }; }
        if (res && res.ok) {
          received.add(index);
          chunkIndex++;
          job.progress = received.size / totalChunks;
          renderTray();
          attempt = 1; // 单次成功后重置重试计数
          continue;
        }
        // 分片失败：换 uploadId 重新 init 拿 received（断点续传），最多 MAX_ATTEMPTS 次
        const errInfo = res ? (await res.json().catch(() => null)) : null;
        if (attempt >= MAX_ATTEMPTS) {
          job.status = 'error';
          job.error = (errInfo && errInfo.error) || `分片上传失败（HTTP ${res ? res.status : '未知'}）`;
          await abortTmp(job);
          renderTray();
          return { ok: false, error: job.error };
        }
        attempt++;
        await sleep(400 * attempt);
        const re = await postJson('/upload/init', initBody);
        if (re && re.ok && re.uploadId) {
          job.uploadId = re.uploadId;
          job.controller = new AbortController();
          received.clear();
          for (const n of (re.received || [])) received.add(Number(n));
          chunkIndex = 0;
          continue;
        }
      }

      job.status = 'uploading';
      job.progress = 0.95;
      renderTray();
      const comp = await completeUpload(job, sha256, false);
      if (job.cancelled) { await abortTmp(job); return { ok: false, cancelled: true }; }
      if (comp && comp.ok) {
        job.status = 'done'; job.progress = 1; job.uploadId = null;
        renderTray();
        return comp;
      }
      job.status = 'error';
      job.error = (comp && comp.error) || '合并文件失败';
      await abortTmp(job);
      renderTray();
      return { ok: false, error: job.error };
    } catch (e) {
      job.status = 'error';
      job.error = String((e && e.message) || e || '未知错误');
      await abortTmp(job);
      renderTray();
      return { ok: false, error: job.error };
    } finally {
      activeJobs.delete(job);
    }
  }

  // complete：普通合并 / 秒传（dedup）两种分支；配文随 single 文件附着
  function completeUpload(job, sha256, dedup, storedName) {
    const fd = new FormData();
    if (dedup) {
      fd.append('dedup', '1');
      fd.append('storedName', storedName);
    } else {
      fd.append('uploadId', job.uploadId);
      fd.append('totalChunks', String(Math.ceil(job.size / 2097152)));
    }
    fd.append('originalName', encodeURIComponent(job.name));
    fd.append('size', String(job.size));
    fd.append('nickname', state.myNickname);
    fd.append('clientId', state.myClientId);
    fd.append('room', state.currentRoom);
    // 语音消息：通知服务端归档到 audio/（webm 扩展名默认会被分到 video/）
    if ((job.file.type || '').indexOf('audio/') === 0) fd.append('audio', '1');
    if (job.caption) fd.append('text', job.caption);
    if (sha256) fd.append('sha256', sha256);
    return fetch('/upload/complete', { method: 'POST', body: fd })
      .then((r) => r.json().catch(() => null)).catch(() => null);
  }

  // 供 chat 分片发送时调用：上传整个队列；单文件+配文 → 图文同发；多文件+配文 → 配文独立先发
  async function sendAttachment(caption) {
    if (!queue.length || sending) return { ok: false };
    sending = true;
    try {
      const text = String(caption || '').trim();
      const jobs = queue.slice();
      if (jobs.length === 1) {
        jobs[0].caption = text; // 图文同发保持原行为
      } else if (text) {
        // 多文件 + 配文 → 配文作为独立文字消息先发，文件各自独立
        app.socket.emit('chat_message', { text, room: state.currentRoom, clientId: state.myClientId });
      }
      const results = [];
      let cursor = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
        while (true) {
          const job = jobs[cursor++];
          if (!job) return;
          results.push(await uploadOne(job));
        }
      });
      await Promise.all(workers);
      // 清理已发送/已取消的任务，保留失败的可重试
      for (let i = queue.length - 1; i >= 0; i--) {
        const j = queue[i];
        if (j.status === 'done' || j.cancelled) queue.splice(i, 1);
      }
      renderTray();
      const failed = results.filter((r) => r && !r.ok && !r.cancelled);
      if (failed.length) {
        app.setHint(`有 ${failed.length} 个文件发送失败，可在托盘里重试`, 'error');
        return { ok: false, error: failed[0].error };
      }
      return { ok: true };
    } finally {
      sending = false;
    }
  }

  // 点击选择文件 → 入队列（多选支持）
  document.querySelector('.file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) {
      Array.from(fileInput.files).forEach((f) => queueFile(f));
      fileInput.value = '';
    }
  });

  // ---------- 粘贴截图：入队列（纯文本粘贴不拦截；群聊弹窗打开时不接管） ----------
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

  // 拖拽：拖到聊天区高亮，松手入队列
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
    if (files && files.length) Array.from(files).forEach((f) => queueFile(f));
  });

  // ---------- 语音消息：录音（MediaRecorder）→ 停止即自动发送为语音消息 ----------
  const micBtn = document.getElementById('micBtn');
  const voiceBar = document.getElementById('voiceBar');
  const voiceTime = document.getElementById('voiceTime');
  const voiceStopBtn = document.getElementById('voiceStopBtn');
  const voiceCancelBtn = document.getElementById('voiceCancelBtn');
  let voiceRec = null;          // MediaRecorder 实例（非空 = 录音中）
  let voiceChunks = [];
  let voiceStream = null;
  let voiceMime = 'audio/webm';
  let voiceTimer = null;
  let voiceStart = 0;
  let voiceCancelled = false;
  const VOICE_MAX_SEC = 5 * 60; // 单条最长 5 分钟，超时自动停止发送

  function updateVoiceTimer() {
    const sec = Math.floor((Date.now() - voiceStart) / 1000);
    if (voiceTime) voiceTime.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    if (sec >= VOICE_MAX_SEC) stopVoice();
  }

  function startVoice() {
    if (!window.MediaRecorder) { app.setHint('当前浏览器不支持录音', 'error'); return; }
    if (voiceRec) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      app.setHint('当前环境无法访问麦克风', 'error');
      return;
    }
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
    const mimeType = candidates.find((m) => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) || '';
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      if (voiceCancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      voiceStream = stream;
      voiceChunks = [];
      voiceMime = mimeType || 'audio/webm';
      voiceRec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceRec.ondataavailable = (e) => { if (e && e.data && e.data.size) voiceChunks.push(e.data); };
      voiceRec.onstop = () => finishVoice();
      voiceRec.start();
      voiceStart = Date.now();
      voiceTimer = setInterval(updateVoiceTimer, 500);
      voiceBar.hidden = false;
      updateVoiceTimer();
      micBtn.classList.add('recording');
    }).catch(() => {
      app.setHint('无法访问麦克风（请检查浏览器权限）', 'error');
    });
  }

  function stopVoice() {
    if (!voiceRec) return;
    clearInterval(voiceTimer); voiceTimer = null;
    try { voiceRec.stop(); } catch (_) { /* 已处于停止态 */ }
  }

  function cancelVoice() {
    if (!voiceRec) return;
    voiceCancelled = true;
    clearInterval(voiceTimer); voiceTimer = null;
    try { voiceRec.stop(); } catch (_) { /* 忽略 */ }
    if (voiceStream) { voiceStream.getTracks().forEach((t) => t.stop()); voiceStream = null; }
    voiceRec = null;
    voiceChunks = [];
    voiceBar.hidden = true;
    micBtn.classList.remove('recording');
  }

  // 录音结束（正常停止 / 取消 / 超时共用）：收尾并（若非取消）发送语音消息
  function finishVoice() {
    clearInterval(voiceTimer); voiceTimer = null;
    const chunks = voiceChunks; voiceChunks = [];
    const stream = voiceStream; voiceStream = null;
    const mime = voiceMime || 'audio/webm';
    voiceRec = null;
    voiceBar.hidden = true;
    micBtn.classList.remove('recording');
    if (voiceCancelled) { voiceCancelled = false; if (stream) stream.getTracks().forEach((t) => t.stop()); return; }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (!chunks.length) { app.setHint('录音为空，未发送', 'error'); return; }
    const blob = new Blob(chunks, { type: mime });
    const ext = mime.indexOf('ogg') >= 0 ? 'ogg' : (mime.indexOf('mp4') >= 0 || mime.indexOf('m4a') >= 0) ? 'm4a' : 'webm';
    const pad2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const name = `语音消息-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}.${ext}`;
    const file = new File([blob], name, { type: mime, lastModified: Date.now() });
    const wasEmpty = queue.length === 0;
    queueFile(file);
    if (wasEmpty) {
      // 队列原本为空 → 停止即自动发送
      sendAttachment('').then((r) => { if (r && !r.ok) app.setHint('语音发送失败，可在托盘重试', 'error'); });
    } else {
      app.setHint('录音已加入发送队列', 'success');
    }
  }

  if (micBtn) {
    micBtn.addEventListener('click', () => { if (voiceRec) stopVoice(); else startVoice(); });
    if (!window.MediaRecorder) micBtn.hidden = true; // 不支持录音的浏览器隐藏麦克风按钮
  }
  if (voiceStopBtn) voiceStopBtn.addEventListener('click', () => stopVoice());
  if (voiceCancelBtn) voiceCancelBtn.addEventListener('click', () => cancelVoice());

  // 暴露给 chat 分片（发送）与 rooms 分片（切房时清托盘，防发错房间）；queueFile/cancelPending/retryPending 供 UI 与测试驱动
  Object.assign(app, {
    hasPendingAttachment,
    sendAttachment,
    clearAttachment,
    queueFile,
    cancelPending: (i) => { const j = queue[i]; if (j) cancelJob(j); },
    retryPending: (i) => { const j = queue[i]; if (j) retryJob(j); },
    startVoice, stopVoice, cancelVoice
  });
})();
