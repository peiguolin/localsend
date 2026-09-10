(function () {
  'use strict';

  const socket = io();

  // ---------- DOM 引用 ----------
  const connStatus = document.getElementById('connStatus');
  const onlineCount = document.getElementById('onlineCount');
  const myNameEl = document.getElementById('myName');
  const chatArea = document.getElementById('chatArea');
  const memberList = document.getElementById('memberList');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('fileInput');
  const uploadHint = document.getElementById('uploadHint');
  const unreadPill = document.getElementById('unreadPill');
  const unreadPillText = document.getElementById('unreadPillText');
  const myNameInput = document.getElementById('myNameInput');
  const nickError = document.getElementById('nickError');

  const NICK_STORAGE_KEY = 'localsend-nickname';
  let myNickname = '';
  let nickEditing = false;
  let nickErrorTimer = null;

  // ---------- 工具函数 ----------
  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function appendMsg(node) {
    chatArea.appendChild(node);
    // 用户停留在底部时才自动滚到底；翻看历史时不动滚动条
    if (isNearBottom()) {
      chatArea.scrollTop = chatArea.scrollHeight;
    }
  }

  // ---------- 未读消息提醒（标签页红点 / 标题计数 / 桌面通知 / 提示音 / 页内浮条） ----------
  const BASE_TITLE = document.title;
  const SCROLL_THRESHOLD = 60;
  let unreadCount = 0;

  function isNearBottom() {
    return chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < SCROLL_THRESHOLD;
  }

  function scrollToBottom(smooth) {
    chatArea.scrollTo({ top: chatArea.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  // 生成 favicon：蓝色圆底 + 白色圆点，有未读时右上角画红点与数字
  function drawFavicon(count) {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#4f6ef7';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(16, 16, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    if (count > 0) {
      const r = count > 9 ? 10 : 8;
      ctx.beginPath();
      ctx.arc(26, 6, r, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(count > 99 ? '99+' : String(count), 26, 7);
    }
    return canvas.toDataURL('image/png');
  }

  function updateTabIndicator() {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = drawFavicon(unreadCount);
    document.title = unreadCount > 0 ? `(${unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
  }

  // 桌面通知（需用户授权；授权在首次交互时请求）
  function ensureNotifPermission() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    Notification.requestPermission().catch(() => {});
  }

  function notifyDesktop(data) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    let body = '';
    if (data.type === 'image') body = '[图片] ' + (data.fileName || '');
    else if (data.type === 'file') body = '[文件] ' + (data.fileName || '');
    else body = data.text || '';
    try {
      const n = new Notification(`${data.nickname} 发来消息`, {
        body: body.slice(0, 80),
        icon: drawFavicon(0),
        tag: 'chat-' + data.timestamp
      });
      n.onclick = () => { window.focus(); resetUnread(); };
    } catch (_) { /* 忽略通知失败 */ }
  }

  // 提示音：Web Audio 两段短音（叮咚），无需音频文件
  let audioCtx = null;
  function playPing() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      [880, 1174].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const t0 = audioCtx.currentTime + i * 0.12;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.22);
      });
    } catch (_) { /* 忽略音频失败 */ }
  }

  // 页内"新消息"浮条
  function showUnreadPill() {
    unreadPillText.textContent = `${unreadCount} 条新消息`;
    unreadPill.classList.add('show');
  }

  function hideUnreadPill() {
    unreadPill.classList.remove('show');
  }

  function resetUnread() {
    if (unreadCount === 0) return;
    unreadCount = 0;
    updateTabIndicator();
    hideUnreadPill();
  }

  // 收到消息后的未读判定：自己的消息 / 页面有焦点都不计数
  function handleIncomingMessage(data) {
    if (data.nickname === myNickname || document.hasFocus()) return;
    unreadCount++;
    updateTabIndicator();
    if (!isNearBottom()) showUnreadPill();
    if (document.visibilityState === 'hidden') notifyDesktop(data);
    playPing();
  }

  function setHint(text, cls) {
    uploadHint.textContent = text;
    uploadHint.className = 'upload-hint show' + (cls ? ' ' + cls : '');
  }

  // ---------- 消息渲染 ----------
  function renderSystemMsg(data) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = `
      <div class="msg-bubble">${escapeHtml(data.text || '')}</div>
    `;
    appendMsg(div);
  }

  function renderTextMsg(data) {
    const isSelf = data.nickname === myNickname;
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      <div class="msg-bubble">${escapeHtml(data.text)}</div>
    `;
    appendMsg(div);
  }

  function renderFileMsg(data) {
    const isSelf = data.nickname === myNickname;
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      <div class="msg-bubble file-bubble">
        <div class="file-card">
          <div class="file-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
              <polyline points="13 2 13 9 20 9"/>
            </svg>
          </div>
          <div class="file-info">
            <div class="file-name" title="${escapeHtml(data.fileName)}">${escapeHtml(data.fileName)}</div>
            <div class="file-size">${fmtSize(data.size)}</div>
          </div>
          <a class="download-btn" href="${escapeHtml(data.downloadUrl)}" download>下载</a>
        </div>
      </div>
    `;
    appendMsg(div);
  }

  function renderImageMsg(data) {
    const isSelf = data.nickname === myNickname;
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      <div class="msg-bubble image-bubble">
        <img class="msg-image" src="${escapeHtml(data.imageUrl)}" alt="${escapeHtml(data.fileName)}" title="${escapeHtml(data.fileName)}" loading="lazy">
      </div>
    `;
    const img = div.querySelector('.msg-image');
    img.addEventListener('click', () => openLightbox(data));
    img.addEventListener('error', () => {
      const bubble = div.querySelector('.image-bubble');
      bubble.innerHTML = `
        <div class="image-error-tip">图片加载失败</div>
        <a class="download-btn" href="${escapeHtml(data.downloadUrl)}" download>下载原图</a>
      `;
    });
    appendMsg(div);
  }

  // ---------- 图片灯箱（点击放大预览） ----------
  function openLightbox(data) {
    let overlay = document.getElementById('lightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'lightbox';
      overlay.className = 'lightbox';
      overlay.innerHTML = `
        <div class="lightbox-backdrop"></div>
        <div class="lightbox-content">
          <img class="lightbox-img" alt="">
          <div class="lightbox-bar">
            <span class="lightbox-name"></span>
            <a class="lightbox-download" download>下载原图</a>
            <button class="lightbox-close" type="button">关闭</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay ||
            e.target.classList.contains('lightbox-backdrop') ||
            e.target.classList.contains('lightbox-close')) {
          overlay.classList.remove('show');
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('show')) {
          overlay.classList.remove('show');
        }
      });
    }
    overlay.querySelector('.lightbox-img').src = data.imageUrl;
    overlay.querySelector('.lightbox-img').alt = data.fileName || '';
    overlay.querySelector('.lightbox-name').textContent =
      data.fileName ? `${data.fileName}（${fmtSize(data.size)}）` : fmtSize(data.size);
    overlay.querySelector('.lightbox-download').href = data.downloadUrl;
    overlay.classList.add('show');
  }

  // ---------- 成员列表 ----------
  function renderMembers(members) {
    onlineCount.textContent = members.length;
    memberList.innerHTML = '';
    if (!members.length) {
      const li = document.createElement('li');
      li.className = 'empty-members';
      li.textContent = '暂无在线成员';
      memberList.appendChild(li);
      return;
    }
    members.forEach((name) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'member-dot';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = name;
      nameSpan.style.overflow = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.whiteSpace = 'nowrap';
      li.appendChild(dot);
      li.appendChild(nameSpan);
      if (name === myNickname) {
        const me = document.createElement('span');
        me.className = 'member-me';
        me.textContent = '我';
        li.appendChild(me);
      }
      memberList.appendChild(li);
    });
  }

  // ---------- Socket 事件 ----------
  socket.on('connect', () => {
    connStatus.textContent = '已连接';
    connStatus.className = 'badge online';
  });

  socket.on('disconnect', () => {
    connStatus.textContent = '已断开';
    connStatus.className = 'badge offline';
  });

  socket.on('welcome', (data) => {
    myNickname = data.nickname;
    myNameEl.textContent = myNickname;
    renderSystemMsg({
      text: `你已加入聊天室，你的昵称是 ${myNickname}`
    });
    onlineCount.textContent = data.online;
    // 恢复上次使用的昵称（静默改名，不广播系统消息；被占用则放弃）
    let saved = null;
    try { saved = localStorage.getItem(NICK_STORAGE_KEY); } catch (_) { /* ignore */ }
    if (saved && saved !== myNickname) {
      socket.emit('set_nickname', { name: saved, silent: true }, (res) => {
        if (res && res.ok) {
          applyNickname(res.nickname);
        } else {
          try { localStorage.removeItem(NICK_STORAGE_KEY); } catch (_) { /* ignore */ }
        }
      });
    }
  });

  socket.on('system_message', (data) => {
    renderSystemMsg(data);
  });

  socket.on('chat_message', (data) => {
    if (data.type === 'image') {
      renderImageMsg(data);
    } else if (data.type === 'file') {
      renderFileMsg(data);
    } else {
      renderTextMsg(data);
    }
    handleIncomingMessage(data);
  });

  socket.on('members_update', (members) => {
    renderMembers(members);
  });

  // ---------- 发送聊天消息 ----------
  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text) return;
    socket.emit('chat_message', { text });
    msgInput.value = '';
    msgInput.focus();
    scrollToBottom(true);
    hideUnreadPill();
  }

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ---------- 文件上传 ----------
  function uploadFile(file) {
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) {
      setHint('文件超过 200MB 大小限制', 'error');
      return;
    }
    setHint(`正在上传 ${file.name} …`);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('nickname', myNickname);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        setHint(`正在上传 ${file.name} … ${pct}%`);
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        setHint(`已发送文件 ${file.name}`, 'success');
      } else {
        let msg = '上传失败';
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.error) msg = res.error;
        } catch (_) { /* ignore */ }
        setHint(msg, 'error');
      }
    };
    xhr.onerror = () => {
      setHint('上传失败，请检查网络连接', 'error');
    };
    xhr.send(formData);
  }

  // 点击选择文件
  document.querySelector('.file-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      uploadFile(fileInput.files[0]);
      fileInput.value = '';
    }
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

  // ---------- 未读提醒的初始化 ----------
  // 回到页面 / 窗口获得焦点 → 清空未读
  window.addEventListener('focus', resetUnread);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resetUnread();
  });
  // 滚动回底部 → 隐藏浮条
  chatArea.addEventListener('scroll', () => {
    if (isNearBottom()) hideUnreadPill();
  });
  // 点击浮条 → 清未读并滚到底部
  unreadPill.addEventListener('click', () => {
    resetUnread();
    scrollToBottom(true);
  });
  // 桌面通知权限必须在用户手势中请求：首次点击/按键时尝试
  ['pointerdown', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, ensureNotifPermission, { capture: true, once: true });
  });
  // 初始 favicon（蓝色圆点）
  updateTabIndicator();

  // ---------- 昵称修改（点击顶栏昵称内联编辑） ----------
  function applyNickname(name) {
    myNickname = name;
    myNameEl.textContent = name;
    try { localStorage.setItem(NICK_STORAGE_KEY, name); } catch (_) { /* ignore */ }
  }

  function showNickError(text) {
    nickError.textContent = text;
    nickError.hidden = false;
    clearTimeout(nickErrorTimer);
    nickErrorTimer = setTimeout(() => { nickError.hidden = true; }, 3000);
  }

  function closeNickEditor() {
    myNameInput.hidden = true;
    myNameEl.hidden = false;
    nickEditing = false;
  }

  function submitNickname() {
    if (!nickEditing) return;
    const name = myNameInput.value.trim();
    if (!name || name === myNickname) {
      closeNickEditor();
      return;
    }
    socket.emit('set_nickname', { name }, (res) => {
      if (res && res.ok) {
        applyNickname(res.nickname);
      } else {
        showNickError((res && res.error) || '修改昵称失败');
      }
      closeNickEditor();
    });
  }

  myNameEl.addEventListener('click', () => {
    if (nickEditing) return;
    nickEditing = true;
    myNameInput.value = myNickname;
    myNameEl.hidden = true;
    myNameInput.hidden = false;
    myNameInput.focus();
    myNameInput.select();
  });
  myNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitNickname();
    } else if (e.key === 'Escape') {
      closeNickEditor();
    }
  });
  myNameInput.addEventListener('blur', submitNickname);

  // 防止浏览器直接打开拖入文件
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // 暴露给 share.js（文件夹共享面板复用同一 socket 与工具函数）
  window.chatApp = {
    socket,
    utils: { escapeHtml, fmtSize, fmtTime },
    get nickname() { return myNickname; }
  };
})();
