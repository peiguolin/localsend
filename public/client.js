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
  // WebRTC 通话弹窗
  const callModal = document.getElementById('callModal');
  const callTitle = document.getElementById('callTitle');
  const callStatus = document.getElementById('callStatus');
  const callMembers = document.getElementById('callMembers');
  const callTimerEl = document.getElementById('callTimer');
  const callAudios = document.getElementById('callAudios');
  const callAcceptBtn = document.getElementById('callAcceptBtn');
  const callRejectBtn = document.getElementById('callRejectBtn');
  const callMuteBtn = document.getElementById('callMuteBtn');
  const callEndBtn = document.getElementById('callEndBtn');
  // 多选呼叫
  const groupCallBtn = document.getElementById('groupCallBtn');
  const memberSelectHint = document.getElementById('memberSelectHint');
  const callActionBar = document.getElementById('callActionBar');
  const callSelectedBtn = document.getElementById('callSelectedBtn');
  const callSelectionClearBtn = document.getElementById('callSelectionClearBtn');

  const NICK_STORAGE_KEY = 'localsend-nickname';
  let myNickname = '';
  let myId = '';
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

  // ---------- 多方语音通话（WebRTC Mesh 房间模型） ----------
  // 状态机：idle → ringing(主叫等待) / incoming(被叫来电) → active(通话中) → idle
  // Mesh：每个成员与房间内其他每位成员各建一条 RTCPeerConnection（peers: Map<peerId, pc>）
  let callState = 'idle';
  let roomId = '';
  let myRole = '';          // 'caller' | 'callee'
  let callerId = '';        // 房间发起者 socket id
  let roster = [];          // [{id, nickname}] 已接通成员（含自己）
  let ringingTargets = [];  // 主叫侧：仍待接听的 [{id, nickname}]
  let peers = new Map();    // peerId -> RTCPeerConnection
  let localStream = null;
  let callTimer = null;
  let callSec = 0;
  let ringCtx = null;
  let ringTimer = null;
  let muted = false;

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  function fmtDuration(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // ---------- 通话 UI ----------
  function showCallModal() { callModal.hidden = false; }

  function hideCallModal() {
    callModal.hidden = true;
    callTimerEl.hidden = true;
    callTimerEl.textContent = '00:00';
    callAcceptBtn.hidden = true;
    callRejectBtn.hidden = true;
    callMuteBtn.hidden = true;
    callEndBtn.hidden = true;
    callStatus.hidden = false;
    callStatus.textContent = '';
    callTitle.textContent = '语音通话';
    callMembers.innerHTML = '';
  }

  // 渲染房间成员 chips（已接通 + 主叫侧仍在振铃的）
  function renderCallMembers() {
    callMembers.innerHTML = '';
    roster.forEach((m) => {
      const chip = document.createElement('span');
      chip.className = 'call-chip' + (m.id === myId ? ' me' : '');
      chip.textContent = m.nickname;
      callMembers.appendChild(chip);
    });
    ringingTargets.forEach((t) => {
      if (!roster.some((m) => m.id === t.id)) {
        const chip = document.createElement('span');
        chip.className = 'call-chip ringing';
        chip.textContent = t.nickname + '…';
        callMembers.appendChild(chip);
      }
    });
  }

  function setCallUI(state) {
    showCallModal();
    callAcceptBtn.hidden = !(state === 'incoming');
    callRejectBtn.hidden = !(state === 'incoming');
    callMuteBtn.hidden = !(state === 'active');
    callMuteBtn.textContent = muted ? '取消静音' : '静音';
    callEndBtn.hidden = false;
    callEndBtn.textContent = (state === 'ringing') ? '取消' : '挂断';
    if (state === 'ringing') {
      callTitle.textContent = '正在呼叫…';
      callStatus.textContent = '等待接听';
      callStatus.hidden = false;
    } else if (state === 'incoming') {
      const who = roster[0] ? roster[0].nickname : '';
      const group = ringingTargets.length > 1;
      callTitle.textContent = '来电';
      callStatus.textContent = (group ? `${who} 邀请你加入群聊通话` : `${who} 邀请你语音通话`);
      callStatus.hidden = false;
    } else if (state === 'active') {
      callTitle.textContent = roster.length > 2 ? `通话中 (${roster.length} 人)` : '通话中';
      callStatus.hidden = true;
      callTimerEl.hidden = false;
    }
    renderCallMembers();
  }

  function startCallTimer() {
    callSec = 0;
    callTimerEl.textContent = '00:00';
    clearInterval(callTimer);
    callTimer = setInterval(() => {
      callSec++;
      callTimerEl.textContent = fmtDuration(callSec);
    }, 1000);
  }

  function stopCallTimer() {
    clearInterval(callTimer);
    callTimer = null;
    callSec = 0;
  }

  // ---------- 铃声（Web Audio 模拟来电振铃） ----------
  function startRingTone() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ringCtx) ringCtx = new AC();
      if (ringCtx.state === 'suspended') ringCtx.resume();
      ringTimer = setInterval(() => {
        const t0 = ringCtx.currentTime;
        [880, 1174].forEach((freq, i) => {
          const osc = ringCtx.createOscillator();
          const gain = ringCtx.createGain();
          const tt = t0 + i * 0.14;
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, tt);
          gain.gain.exponentialRampToValueAtTime(0.16, tt + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, tt + 0.22);
          osc.connect(gain).connect(ringCtx.destination);
          osc.start(tt);
          osc.stop(tt + 0.24);
        });
      }, 1400);
    } catch (_) { /* 忽略铃声失败 */ }
  }

  function stopRingTone() {
    clearInterval(ringTimer);
    ringTimer = null;
  }

  // ---------- RTCPeerConnection 管理（每对端一条） ----------
  function ensurePeer(peerId) {
    let p = peers.get(peerId);
    if (p) return p;
    p = new RTCPeerConnection(RTC_CONFIG);
    if (localStream) localStream.getTracks().forEach((t) => p.addTrack(t, localStream));
    // 每路远端音频一个独立 audio 元素（Mesh 多路同时播放）
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.hidden = true;
    audioEl.dataset.peer = peerId;
    callAudios.appendChild(audioEl);
    p.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        audioEl.srcObject = e.streams[0];
        audioEl.hidden = false;
        audioEl.play().catch(() => {});
      }
    };
    p.onicecandidate = (e) => {
      if (e.candidate && callState === 'active' && roomId) {
        socket.emit('rtc_ice', { toId: peerId, roomId, candidate: e.candidate });
      }
    };
    p.onconnectionstatechange = () => {
      if (p.connectionState === 'failed' || p.connectionState === 'disconnected') {
        // 单路连接失败：只移除这一路，不结束整个通话
        removePeer(peerId);
      }
    };
    peers.set(peerId, p);
    return p;
  }

  function removePeer(peerId) {
    const p = peers.get(peerId);
    if (p) {
      try { p.onicecandidate = null; p.ontrack = null; p.onconnectionstatechange = null; } catch (_) {}
      try { p.close(); } catch (_) {}
      peers.delete(peerId);
    }
    const audioEl = callAudios.querySelector(`audio[data-peer="${peerId}"]`);
    if (audioEl) audioEl.remove();
  }

  function closeAllPeers() {
    for (const id of Array.from(peers.keys())) removePeer(id);
    peers.clear();
  }

  // 收尾：清理媒体/连接/UI/铃声，回到 idle
  function cleanupCall(message) {
    stopCallTimer();
    stopRingTone();
    closeAllPeers();
    if (localStream) {
      localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      localStream = null;
    }
    callAudios.innerHTML = '';
    roomId = '';
    callerId = '';
    myRole = '';
    roster = [];
    ringingTargets = [];
    muted = false;
    callState = 'idle';
    hideCallModal();
    if (message) setHint(message, 'success');
  }

  function failCall(message) {
    cleanupCall(message || '通话结束');
  }

  async function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('浏览器不支持麦克风（需 HTTPS + 现代浏览器）');
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  // ---------- 对外动作 ----------
  // 主叫：对一批目标发起通话（1:1 即 targets=[1人]）
  async function startCall(targets) {
    if (callState !== 'idle') return;
    const list = (targets || []).filter((t) => t && t.id && t.id !== myId);
    if (!list.length) return;
    myRole = 'caller';
    callerId = myId;
    roster = [{ id: myId, nickname: myNickname }];
    ringingTargets = list.map((t) => ({ id: t.id, nickname: t.nickname || '对方' }));
    callState = 'ringing';
    setCallUI('ringing');
    startRingTone();
    try {
      localStream = await getMic();
    } catch (_) {
      failCall('无法获取麦克风权限，请检查浏览器设置');
      return;
    }
    socket.emit('call_user', { targets: list.map((t) => t.id) });
  }

  // 被叫：接听（接听后作为新成员向既有成员发 offer）
  async function acceptCall() {
    if (callState !== 'incoming') return;
    stopRingTone();
    try {
      localStream = await getMic();
    } catch (_) {
      socket.emit('call_reject', { roomId });
      failCall('无法获取麦克风权限，已拒绝通话');
      return;
    }
    callState = 'active';
    socket.emit('call_accept', { roomId });
    startCallTimer();
  }

  // 被叫：拒绝
  function rejectCall() {
    if (callState !== 'incoming') return;
    socket.emit('call_reject', { roomId });
    stopRingTone();
    hideCallModal();
    callState = 'idle';
    roster = [];
    ringingTargets = [];
  }

  // 静音切换
  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    callMuteBtn.textContent = muted ? '取消静音' : '静音';
  }

  // 挂断 / 取消（房间模型统一走 call_end）
  function endCall() {
    if (callState === 'idle') return;
    if (callState === 'incoming') { rejectCall(); return; }
    if (roomId) socket.emit('call_end', { roomId });
    cleanupCall();
  }

  // ---------- 信令监听 ----------
  socket.on('incoming_call', (data) => {
    if (callState !== 'idle') {
      // 忙线：直接拒绝（正常不会发生，服务端已过滤；防竞态）
      socket.emit('call_reject', { roomId: data.roomId });
      return;
    }
    roomId = data.roomId || '';
    callerId = data.fromId || '';
    myRole = 'callee';
    roster = (data.roster && data.roster.length ? data.roster : [{ id: data.fromId, nickname: data.fromName }]);
    ringingTargets = data.targets || [];
    callState = 'incoming';
    setCallUI('incoming');
    startRingTone();
    // 页面在后台也提醒
    if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const who = roster[0] ? roster[0].nickname : '';
        const group = ringingTargets.length > 1;
        const n = new Notification(`${who} ${group ? '邀请你加入群聊通话' : '邀请你语音通话'}`, { body: '点击接听', icon: drawFavicon(0), tag: 'call' });
        n.onclick = () => { window.focus(); };
      } catch (_) {}
    }
  });

  socket.on('call_ringing', (data) => {
    if (callState !== 'ringing') return;
    roomId = data.roomId || roomId;
    if (Array.isArray(data.targets)) {
      ringingTargets = data.targets.map((t) => ({ id: t.id, nickname: t.nickname || '对方' }));
    }
    setCallUI('ringing');
    // 有忙线/离线目标 → 提示
    const busyNames = (data.busy || []).map((b) => b.nickname).filter(Boolean);
    const offlineNames = (data.offline || []).map((b) => b.nickname).filter(Boolean);
    if (busyNames.length || offlineNames.length) {
      const parts = [];
      if (busyNames.length) parts.push(`${busyNames.join('、')} 忙线`);
      if (offlineNames.length) parts.push(`${offlineNames.join('、')} 不在线`);
      setHint('已跳过：' + parts.join('，'), '');
    }
  });

  // 有人加入房间：更新名单；新成员（自己）向所有既有成员发 offer
  socket.on('room_member_joined', async (data) => {
    if (callState === 'idle' || data.roomId !== roomId) return;
    const prevRoster = roster;
    roster = (data.members || []).filter((m) => m);
    const newMember = data.member;
    const iAmNew = newMember && newMember.id === myId;
    if (callState === 'ringing') {
      // 主叫：第一个成员接听 → 通话开始
      callState = 'active';
      stopRingTone();
      setCallUI('active');
      startCallTimer();
    } else {
      setCallUI(callState);
    }
    if (iAmNew && localStream) {
      // 新成员：主动向每个既有成员发 offer（避免 glare）
      for (const m of roster) {
        if (m.id === myId) continue;
        try {
          const p = ensurePeer(m.id);
          const offer = await p.createOffer();
          await p.setLocalDescription(offer);
          socket.emit('rtc_offer', { toId: m.id, roomId, sdp: p.localDescription });
        } catch (_) {}
      }
    }
    // 主叫的振铃列表：移除已接听的人
    if (myRole === 'caller' && iAmNew === false) {
      ringingTargets = ringingTargets.filter((t) => t.id !== (newMember && newMember.id));
    }
    void prevRoster;
  });

  // 有人离开房间
  socket.on('room_member_left', (data) => {
    if (callState === 'idle' || data.roomId !== roomId) return;
    const leaverId = data.memberId;
    removePeer(leaverId);
    roster = roster.filter((m) => m.id !== leaverId);
    if (roster.length <= 1) {
      // 只剩自己（或空了）→ 结束
      cleanupCall(data.reason === 'offline' ? '对方已离线，通话结束' : '通话已结束');
      return;
    }
    setCallUI('active');
    if (data.memberName) setHint(`${data.memberName} 离开了通话`, 'success');
  });

  socket.on('call_rejected', (data) => {
    if (callState === 'ringing') {
      setHint(`${(data && data.memberName) || '有人'} 拒绝了通话`, '');
      if (data && data.memberId) {
        ringingTargets = ringingTargets.filter((t) => t.id !== data.memberId);
        renderCallMembers();
      }
    }
  });

  socket.on('call_failed', (data) => {
    if (callState === 'ringing' || callState === 'incoming') {
      failCall((data && data.error) || '无法建立通话');
    }
  });

  socket.on('call_cancelled', () => {
    if (callState === 'incoming') {
      stopRingTone();
      hideCallModal();
      callState = 'idle';
      roster = [];
      ringingTargets = [];
      setHint('对方已取消通话', 'success');
    }
  });

  socket.on('rtc_offer', async (data) => {
    if (callState === 'idle' || data.roomId !== roomId) return;
    const fromId = data.fromId;
    if (!fromId || fromId === myId) return;
    try {
      const p = ensurePeer(fromId);
      if (p.remoteDescription) return; // 已有协商
      await p.setRemoteDescription(data.sdp);
      const answer = await p.createAnswer();
      await p.setLocalDescription(answer);
      socket.emit('rtc_answer', { toId: fromId, roomId, sdp: p.localDescription });
    } catch (_) { /* 忽略 */ }
  });

  socket.on('rtc_answer', async (data) => {
    if (callState === 'idle' || data.roomId !== roomId) return;
    const p = peers.get(data.fromId);
    if (!p || p.remoteDescription) return;
    try { await p.setRemoteDescription(data.sdp); } catch (_) { /* 忽略 */ }
  });

  socket.on('rtc_ice', async (data) => {
    if (callState === 'idle' || data.roomId !== roomId) return;
    const p = peers.get(data.fromId);
    if (!p) return;
    try { await p.addIceCandidate(data.candidate); } catch (_) { /* 候选可能已过期 */ }
  });

  // 按钮绑定
  callAcceptBtn.addEventListener('click', acceptCall);
  callRejectBtn.addEventListener('click', rejectCall);
  callMuteBtn.addEventListener('click', toggleMute);
  callEndBtn.addEventListener('click', endCall);
  groupCallBtn.addEventListener('click', groupCall);
  callSelectedBtn.addEventListener('click', callSelected);
  callSelectionClearBtn.addEventListener('click', () => {
    selectedMembers.clear();
    updateCallActionBar();
    renderMembers(currentMembers);
  });

  // 断线清理
  socket.on('disconnect', () => {
    if (callState !== 'idle') cleanupCall('连接断开，通话结束');
  });

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
  const selectedMembers = new Set(); // 多选呼叫的成员 id
  let currentMembers = [];           // 最新成员 [{id, nickname}] 缓存（群呼/所选呼叫用）

  function updateCallActionBar() {
    const n = selectedMembers.size;
    if (n > 0) {
      callActionBar.hidden = false;
      callSelectedBtn.textContent = `发起通话 (${n})`;
    } else {
      callActionBar.hidden = true;
    }
  }

  function renderMembers(members) {
    currentMembers = members;
    onlineCount.textContent = members.length;
    memberList.innerHTML = '';
    // 清理已离线的选中项
    const liveIds = new Set(members.map((m) => m && m.id).filter(Boolean));
    for (const sid of Array.from(selectedMembers)) {
      if (!liveIds.has(sid)) selectedMembers.delete(sid);
    }
    updateCallActionBar();
    if (!members.length) {
      const li = document.createElement('li');
      li.className = 'empty-members';
      li.textContent = '暂无在线成员';
      memberList.appendChild(li);
      return;
    }
    members.forEach((m) => {
      const name = (m && m.nickname) || String(m);
      const id = m && m.id;
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
      if (name === myNickname && id === myId) {
        const me = document.createElement('span');
        me.className = 'member-me';
        me.textContent = '我';
        li.appendChild(me);
      } else if (id && id !== myId) {
        // 点击名字多选（用于群呼）；hover 电话图标快速单呼
        li.classList.add('selectable');
        li.title = '点击名字可多选，然后发起通话';
        if (selectedMembers.has(id)) li.classList.add('selected');
        li.addEventListener('click', () => {
          if (selectedMembers.has(id)) selectedMembers.delete(id);
          else selectedMembers.add(id);
          renderMembers(members);
        });
        // 语音通话按钮（快速单呼）
        const callBtn = document.createElement('button');
        callBtn.type = 'button';
        callBtn.className = 'member-call';
        callBtn.title = `语音呼叫 ${name}`;
        callBtn.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
        callBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          startCall([{ id, nickname: name }]);
        });
        li.appendChild(callBtn);
      }
      memberList.appendChild(li);
    });
  }

  // 群呼：呼叫所有在线成员（不含自己）
  function groupCall() {
    const list = currentMembers.filter((m) => m && m.id && m.id !== myId);
    if (!list.length) {
      setHint('当前没有可呼叫的在线成员', '');
      return;
    }
    startCall(list);
  }

  // 多选呼叫：呼叫已选中的成员
  function callSelected() {
    const list = currentMembers.filter((m) => m && selectedMembers.has(m.id));
    if (!list.length) return;
    startCall(list);
    selectedMembers.clear();
    updateCallActionBar();
    renderMembers(currentMembers);
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
    myId = data.id || '';
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
