(function () {
  'use strict';

  // 持久身份：同一浏览器生成一次，重进/换昵称/换设备不丢；用于判断"哪条消息是我发的"
  // 也随握手发给服务端，服务端据此下发我加入的群聊房并自动加入对应 Socket.IO room
  const CLIENT_ID_KEY = 'localsend-client-id';
  let myClientId = '';
  try {
    myClientId = localStorage.getItem(CLIENT_ID_KEY) || '';
    if (!myClientId) {
      myClientId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(CLIENT_ID_KEY, myClientId);
    }
  } catch (_) { /* localStorage 不可用时用随机值（本次会话内仍能正确归属） */
    myClientId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // 握手带持久 clientId：服务端据此下发我加入的群聊房并自动加入对应 Socket.IO room
  const socket = io({ auth: { clientId: myClientId } });

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
  // ---------- 群聊房间状态 ----------
  let currentRoom = 'main';      // 当前正在查看的房间（默认公共房）
  let myRooms = [];              // 我加入的群聊房 [{id,name,members,...}]
  const roomUnread = new Map();  // room -> 未读数（'main' 也统计）
  // ---------- 群聊房间状态（end） ----------
  // 持久身份 myClientId 已在 IIFE 顶部初始化（握手需要）
  let nickEditing = false;
  let nickErrorTimer = null;
  let latestMembers = []; // 最新成员列表（@ 自动补全数据源）

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
      const n = new Notification(data.mention ? `${data.nickname} 提到了你` : `${data.nickname} 发来消息`, {
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

  // @提及提示音：三连高音上行，与普通消息双音区分
  function playMentionPing() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      [988, 1319, 1568].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const t0 = audioCtx.currentTime + i * 0.09;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.14, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.2);
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

  // 收到消息后的未读判定：自己的消息 / 页面有焦点都不计数；@提及时播放专属提示音
  function handleIncomingMessage(data) {
    if (isOwnMessage(data)) return;
    const mentioned = (data.mentions || []).includes(myNickname);
    if (mentioned) playMentionPing();
    if (document.hasFocus()) return;
    unreadCount++;
    updateTabIndicator();
    if (!isNearBottom()) showUnreadPill();
    if (document.visibilityState === 'hidden') notifyDesktop(mentioned ? { ...data, mention: true } : data);
    if (!mentioned) playPing();
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

  // ---------- 消息存储（供引用/撤回/右键菜单定位） ----------
  const msgStore = new Map(); // id -> 消息原始数据（含 recalled 标记）

  // ---------- 消息内容渲染：```代码块 / `行内代码` / @提及（全程先转义再拼接，防 XSS） ----------
  function highlightMentions(html, mentions) {
    const nicks = (mentions || []).slice().sort((a, b) => b.length - a.length);
    for (const nick of nicks) {
      const target = '@' + escapeHtml(nick);
      const cls = nick === myNickname ? 'mention mention-me' : 'mention';
      html = html.split(target).join(`<span class="${cls}">${target}</span>`);
    }
    return html;
  }

  function renderContentHTML(text, data) {
    const segs = [];
    const fenceRe = /```(\w{0,20})\n?([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fenceRe.exec(text))) {
      if (m.index > last) segs.push({ t: 'text', c: text.slice(last, m.index) });
      segs.push({ t: 'code', lang: (m[1] || '').toLowerCase(), c: m[2].replace(/\n$/, '') });
      last = m.index + m[0].length;
    }
    if (last < text.length) segs.push({ t: 'text', c: text.slice(last) });
    return segs.map((seg) => {
      if (seg.t === 'code') {
        return `<div class="code-block"><div class="code-bar"><span class="code-lang">${escapeHtml(seg.lang || 'auto')}</span><button class="code-copy" type="button">复制</button></div><pre><code data-lang="${escapeHtml(seg.lang)}">${escapeHtml(seg.c)}</code></pre></div>`;
      }
      let html = escapeHtml(seg.c).replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
      html = highlightMentions(html, data && data.mentions);
      return html;
    }).join('');
  }

  // 代码块语法高亮（hljs 输出自带转义，可安全 innerHTML）
  function applyCodeHighlight(container) {
    if (!window.hljs) return;
    container.querySelectorAll('.code-block code').forEach((el) => {
      const lang = el.dataset.lang;
      const raw = el.textContent;
      try {
        if (lang && window.hljs.getLanguage(lang)) {
          el.innerHTML = window.hljs.highlight(raw, { language: lang }).value;
        } else {
          const r = window.hljs.highlightAuto(raw);
          el.innerHTML = r.value;
          const label = el.closest('.code-block').querySelector('.code-lang');
          if (label && r.language) label.textContent = r.language;
        }
      } catch (_) { /* 高亮失败保持纯文本 */ }
    });
  }

  function renderQuoteBlock(quote) {
    if (!quote) return '';
    return `<div class="msg-quote" data-qid="${escapeHtml(quote.id)}" title="点击定位原消息">
      <span class="msg-quote-nick">${escapeHtml(quote.nickname)}</span>
      <span class="msg-quote-text">${escapeHtml(quote.text)}</span>
    </div>`;
  }

  // 点击引用块 → 滚动定位原消息并闪烁
  function scrollToMessage(mid) {
    const el = chatArea.querySelector(`[data-mid="${CSS.escape(mid)}"]`);
    if (!el) {
      setHint('原消息不在当前会话中', 'error');
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }

  // 归属判断：优先用持久 clientId（重进/换昵称也正确）；旧数据无 clientId 时退回昵称匹配
  function isOwnMessage(data) {
    if (data && data.clientId) return data.clientId === myClientId;
    return data && data.nickname === myNickname;
  }

  function renderTextMsg(data) {
    const isSelf = isOwnMessage(data);
    const mentionedMe = !isSelf && (data.mentions || []).includes(myNickname);
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other') + (mentionedMe ? ' mentioned' : '');
    if (data.id) div.dataset.mid = data.id;
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-nick">${escapeHtml(data.nickname)}</span>
        <span class="msg-time">${fmtTime(data.timestamp)}</span>
      </div>
      ${renderQuoteBlock(data.quote)}
      <div class="msg-bubble">${renderContentHTML(data.text, data)}</div>
    `;
    applyCodeHighlight(div);
    const q = div.querySelector('.msg-quote');
    if (q) q.addEventListener('click', () => scrollToMessage(q.dataset.qid));
    appendMsg(div);
  }

  function renderFileMsg(data) {
    const isSelf = isOwnMessage(data);
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    if (data.id) div.dataset.mid = data.id;
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
    const isSelf = isOwnMessage(data);
    const div = document.createElement('div');
    div.className = 'msg ' + (isSelf ? 'self' : 'other');
    if (data.id) div.dataset.mid = data.id;
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
    // 加载最近历史消息（SQLite 持久化）
    if (Array.isArray(data.history) && data.history.length) {
      const sep = document.createElement('div');
      sep.className = 'msg system';
      sep.innerHTML = `<div class="msg-bubble">—— 以下为最近 ${data.history.length} 条历史消息 ——</div>`;
      appendMsg(sep);
      data.history.forEach((m) => {
        if (!m || m.recalled) return;
        if (m.id) msgStore.set(m.id, m);
        if (m.type === 'image') renderImageMsg(m);
        else if (m.type === 'file') renderFileMsg(m);
        else renderTextMsg(m);
      });
      const sepEnd = document.createElement('div');
      sepEnd.className = 'msg system';
      sepEnd.innerHTML = `<div class="msg-bubble">—— 历史消息结束 ——</div>`;
      appendMsg(sepEnd);
      scrollToBottom(false);
    }
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
    // 恢复我加入的群聊房（房间持久化：重启后仍在）
    myRooms = Array.isArray(data.rooms) ? data.rooms : [];
    renderRoomList();
  });

  socket.on('system_message', (data) => {
    // 群聊系统消息带 room：只渲染当前房间的；公共房系统消息无 room 字段
    if (data && data.room && data.room !== currentRoom) return;
    renderSystemMsg(data);
  });

  // ==================== 群聊房间 ====================

  function roomDisplayName(room) {
    return room && room.name ? room.name : '群聊';
  }

  // 渲染右侧房间列表（公共房 + 我加入的群聊房）
  function renderRoomList() {
    const list = document.getElementById('roomList');
    const roomMain = document.getElementById('roomMain');
    // 公共房始终第一项，active 态由 currentRoom 决定
    if (roomMain) roomMain.classList.toggle('active', currentRoom === 'main');
    // 移除旧群聊项（保留公共房）
    const old = list.querySelectorAll('.room-item[data-room^="g"]');
    old.forEach((el) => el.remove());
    for (const r of myRooms) {
      const li = document.createElement('li');
      li.className = 'room-item' + (currentRoom === r.id ? ' active' : '');
      li.dataset.room = r.id;
      const unread = roomUnread.get(r.id) || 0;
      const membersText = (r.members || []).map((m) => m.nickname).join('、');
      li.innerHTML =
        `<span class="room-name">${escapeHtml(roomDisplayName(r))}</span>` +
        `<span class="room-members" title="${escapeHtml(membersText)}">${escapeHtml((r.members || []).length + '人')}</span>` +
        `<span class="room-unread" data-role="unread"${unread ? '' : ' hidden'}>${unread}</span>` +
        `<button class="room-leave" data-role="leave" title="退出/解散群聊">✕</button>`;
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-role="leave"]')) {
          e.stopPropagation();
          leaveRoom(r.id);
          return;
        }
        switchRoom(r.id);
      });
      list.appendChild(li);
    }
    updateRoomUnreadBadge(currentRoom);
  }

  // 房间未读角标更新（含顶部 tab 红点联动）
  function updateRoomUnreadBadge(room) {
    const list = document.getElementById('roomList');
    const item = list.querySelector(`.room-item[data-room="${CSS.escape(room)}"]`);
    const badge = item && item.querySelector('[data-role="unread"]');
    const n = roomUnread.get(room) || 0;
    if (badge) {
      badge.textContent = n;
      badge.hidden = n === 0;
    }
  }

  // 切换房间：清空聊天区 → 加载该房间历史 → 更新标题/输入区/房间列表
  function switchRoom(room) {
    if (room === currentRoom) return;
    currentRoom = room;
    roomUnread.set(room, 0);
    chatArea.innerHTML = '';
    msgStore.clear();
    // 更新房间列表 active
    document.querySelectorAll('.room-item').forEach((el) => el.classList.toggle('active', el.dataset.room === room));
    updateRoomUnreadBadge(room);
    updateRoomTitlebar();
    // 加载该房间历史
    socket.emit('room_history', { room }, (res) => {
      if (res && res.ok) {
        const sep = document.createElement('div');
        sep.className = 'msg system';
        sep.innerHTML = `<div class="msg-bubble">—— ${escapeHtml(room === 'main' ? '公共房' : roomDisplayName(myRooms.find((r) => r.id === room)))} 最近 ${res.history.length} 条消息 ——</div>`;
        appendMsg(sep);
        res.history.forEach((m) => {
          if (!m || m.recalled) return;
          if (m.id) msgStore.set(m.id, m);
          if (m.type === 'image') renderImageMsg(m);
          else if (m.type === 'file') renderFileMsg(m);
          else renderTextMsg(m);
        });
        const sepEnd = document.createElement('div');
        sepEnd.className = 'msg system';
        sepEnd.innerHTML = `<div class="msg-bubble">—— 历史消息结束 ——</div>`;
        appendMsg(sepEnd);
        scrollToBottom(false);
      }
    });
  }

  // 顶部标题栏：显示当前房间名（切换房间时刷新）
  function updateRoomTitlebar() {
    let title = '公共房';
    let hint = '所有人都在这里聊天';
    if (currentRoom !== 'main') {
      const r = myRooms.find((x) => x.id === currentRoom);
      title = roomDisplayName(r);
      hint = r ? (r.members || []).map((m) => m.nickname).join('、') : '';
    }
    const bar = document.querySelector('.room-titlebar .rt-name');
    if (bar) bar.textContent = title;
    const hintEl = document.getElementById('roomTitleHint');
    if (hintEl) hintEl.textContent = hint;
  }

  // 退出/解散群聊
  function leaveRoom(room) {
    const r = myRooms.find((x) => x.id === room);
    const label = r ? roomDisplayName(r) : '该群聊';
    if (!confirm(`确定退出「${label}」吗？\n创建者退出将解散该群聊（历史消息保留在服务器）`)) return;
    socket.emit('group_leave', { room }, (res) => {
      if (res && res.ok) {
        if (res.disbanded) {
          removeRoomFromList(room);
        } else {
          removeRoomFromList(room);
        }
        if (currentRoom === room) switchRoom('main');
      } else {
        setHint((res && res.error) || '操作失败', 'error');
      }
    });
  }

  function removeRoomFromList(room) {
    myRooms = myRooms.filter((r) => r.id !== room);
    roomUnread.delete(room);
    renderRoomList();
  }

  // 收到群聊创建通知（被拉的人）
  socket.on('group_invited', (data) => {
    const room = data && data.room;
    if (!room) return;
    if (!myRooms.some((r) => r.id === room.id)) {
      myRooms.push(room);
      renderRoomList();
      setHint(`你被拉入了群聊「${roomDisplayName(room)}」`, 'success');
    }
  });

  // 自己创建的群聊
  socket.on('group_created', (data) => {
    const room = data && data.room;
    if (!room) return;
    if (!myRooms.some((r) => r.id === room.id)) {
      myRooms.push(room);
      renderRoomList();
    }
    setHint(`群聊「${roomDisplayName(room)}」创建成功`, 'success');
  });

  // 群聊被解散 / 自己被移出
  socket.on('group_disbanded', (data) => {
    const room = data && data.room;
    removeRoomFromList(room);
    if (currentRoom === room) switchRoom('main');
    setHint('群聊已解散', '');
  });

  socket.on('group_left', (data) => {
    const room = data && data.room;
    removeRoomFromList(room);
    if (currentRoom === room) switchRoom('main');
  });

  // 群聊改名（服务端广播系统消息；列表名用最新数据刷新）
  socket.on('group_renamed', (data) => {
    const room = data && data.room;
    if (!room) return;
    const idx = myRooms.findIndex((r) => r.id === room.id);
    if (idx >= 0) myRooms[idx] = room;
    renderRoomList();
    if (currentRoom === room.id) updateRoomTitlebar();
  });

  // ---------- 拉起群聊弹窗 ----------
  const groupModal = document.getElementById('groupModal');
  const groupNameInput = document.getElementById('groupNameInput');
  const groupSelList = document.getElementById('groupSelList');
  const groupSelCount = document.getElementById('groupSelCount');
  const groupConfirm = document.getElementById('groupConfirm');
  const groupTip = document.getElementById('groupTip');
  const roomCreateBtn = document.getElementById('roomCreateBtn');
  const groupPickList = document.getElementById('groupPickList');
  let groupSel = new Map(); // socketId -> nickname

  function openGroupModal() {
    // 把当前已在成员列表里勾选的人带入群聊选择（selectedMembers 是通话多选的同一批）
    groupSel = new Map();
    for (const m of currentMembers) {
      if (m && selectedMembers.has(m.id)) groupSel.set(m.id, m.nickname);
    }
    renderGroupSel();
    groupNameInput.value = '';
    groupTip.textContent = groupSel.size
      ? `已带入 ${groupSel.size} 位已选成员，可移除或调整`
      : '从在线成员列表里点击添加，再点「创建群聊」';
    groupModal.hidden = false;
  }

  // 弹窗内在线成员（排除自己与已选），点击添加进群聊
  function renderGroupPick() {
    groupPickList.innerHTML = '';
    for (const m of currentMembers) {
      if (!m || m.id === myId) continue;
      if (groupSel.has(m.id)) continue;
      const chip = document.createElement('span');
      chip.className = 'group-pick-chip';
      chip.textContent = m.nickname;
      chip.addEventListener('click', () => {
        groupSel.set(m.id, m.nickname);
        renderGroupSel();
        renderGroupPick();
      });
      groupPickList.appendChild(chip);
    }
    if (!groupPickList.children.length) {
      const empty = document.createElement('span');
      empty.className = 'group-pick-empty';
      empty.textContent = '没有可添加的成员';
      groupPickList.appendChild(empty);
    }
  }

  function renderGroupSel() {
    groupSelList.innerHTML = '';
    groupSelCount.textContent = groupSel.size;
    groupSel.forEach((nick, sid) => {
      const chip = document.createElement('span');
      chip.className = 'group-sel-chip';
      chip.innerHTML = `${escapeHtml(nick)} <span class="chip-remove" data-sid="${sid}">✕</span>`;
      chip.querySelector('.chip-remove').addEventListener('click', () => {
        groupSel.delete(sid);
        renderGroupSel();
        renderGroupPick();
      });
      groupSelList.appendChild(chip);
    });
    groupConfirm.disabled = groupSel.size === 0;
    renderGroupPick();
  }

  roomCreateBtn.addEventListener('click', openGroupModal);
  document.getElementById('groupCancel').addEventListener('click', () => { groupModal.hidden = true; });
  groupModal.addEventListener('click', (e) => {
    if (e.target === groupModal || e.target.classList.contains('modal-backdrop')) groupModal.hidden = true;
  });
  groupConfirm.addEventListener('click', () => {
    if (!groupSel.size) return;
    const targetIds = Array.from(groupSel.keys());
    const name = groupNameInput.value.trim();
    socket.emit('group_create', { targetIds, name: name || undefined }, (res) => {
      if (res && res.ok) {
        groupModal.hidden = true;
      } else {
        groupTip.textContent = (res && res.error) || '创建失败';
      }
    });
  });

  // 公共房（静态元素）一次性绑定点击切换；renderRoomList 只负责 active 态
  const roomMainEl = document.getElementById('roomMain');
  if (roomMainEl && !roomMainEl._roomClickBound) {
    roomMainEl.addEventListener('click', () => switchRoom('main'));
    roomMainEl._roomClickBound = true;
  }

  // 更新房间标题栏在页面加载后
  window.addEventListener('load', updateRoomTitlebar);

  socket.on('chat_message', (data) => {
    if (data.id) msgStore.set(data.id, data);
    const msgRoom = data.room || 'main';
    if (msgRoom !== currentRoom) {
      // 不是当前房间 → 只加该房间未读（页面有焦点且是当前房间才清，其它房间先计数）
      roomUnread.set(msgRoom, (roomUnread.get(msgRoom) || 0) + 1);
      updateRoomUnreadBadge(msgRoom);
      return;
    }
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
    latestMembers = Array.isArray(members) ? members : [];
    renderMembers(members);
  });

  // ---------- 发送聊天消息 ----------
  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text) return;
    socket.emit('chat_message', { text, quoteId: quoting ? quoting.id : undefined, clientId: myClientId, room: currentRoom });
    msgInput.value = '';
    clearQuote();
    closeAutocomplete();
    msgInput.focus();
    scrollToBottom(true);
    hideUnreadPill();
  }

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    // @ 补全打开时优先处理导航键
    if (acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); acMove(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); acMove(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acSelect(); return; }
      if (e.key === 'Escape') { closeAutocomplete(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ---------- 右键菜单（引用回复 / 复制文本 / 撤回） ----------
  let ctxMenu = null;
  function closeCtxMenu() {
    if (ctxMenu) {
      ctxMenu.remove();
      ctxMenu = null;
    }
  }
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });

  chatArea.addEventListener('contextmenu', (e) => {
    const msgEl = e.target.closest('.msg[data-mid]');
    if (!msgEl) return;
    const data = msgStore.get(msgEl.dataset.mid);
    if (!data || data.recalled) return;
    e.preventDefault();
    openCtxMenu(e.clientX, e.clientY, data);
  });

  function openCtxMenu(x, y, data) {
    closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const items = [{ label: '引用回复', fn: () => startQuote(data) }];
    if (data.type === 'text') {
      items.push({ label: '复制文本', fn: () => copyText(data.text) });
    }
    if (isOwnMessage(data) && Date.now() - data.timestamp < 120000) {
      items.push({ label: '撤回', danger: true, fn: () => recallMessage(data.id) });
    }
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.textContent = it.label;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        it.fn();
        closeCtxMenu();
      });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    ctxMenu = menu;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setHint('已复制', 'success'),
        () => setHint('复制失败', 'error')
      );
    } else {
      setHint('复制失败', 'error');
    }
  }

  // 代码块复制按钮（事件委托，后续消息同样生效）
  chatArea.addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy');
    if (!btn) return;
    const code = btn.closest('.code-block').querySelector('code');
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = '已复制 ✓';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      }, () => setHint('复制失败', 'error'));
    }
  });

  // ---------- 引用回复（输入栏预览条） ----------
  let quoting = null; // {id, nickname, text}
  const quotePreview = document.getElementById('quotePreview');

  function startQuote(data) {
    let text = data.text || '';
    if (data.type === 'file') text = `[文件] ${data.fileName || ''}`;
    else if (data.type === 'image') text = `[图片] ${data.fileName || ''}`;
    text = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    quoting = { id: data.id, nickname: data.nickname, text };
    quotePreview.innerHTML = `
      <span class="quote-preview-label">回复 ${escapeHtml(quoting.nickname)}:</span>
      <span class="quote-preview-text">${escapeHtml(quoting.text)}</span>
      <button class="quote-preview-x" type="button" title="取消引用">×</button>
    `;
    quotePreview.hidden = false;
    quotePreview.querySelector('.quote-preview-x').addEventListener('click', clearQuote);
    msgInput.focus();
  }

  function clearQuote() {
    quoting = null;
    quotePreview.hidden = true;
    quotePreview.innerHTML = '';
  }

  // ---------- 撤回消息 ----------
  function recallMessage(id) {
    socket.emit('chat_recall', { id, clientId: myClientId }, (res) => {
      if (!res || !res.ok) setHint((res && res.error) || '撤回失败', 'error');
    });
  }

  socket.on('chat_recall', (data) => {
    if (!data) return;
    const rec = msgStore.get(data.id);
    if (rec) rec.recalled = true;
    if (quoting && quoting.id === data.id) clearQuote();
    const el = chatArea.querySelector(`[data-mid="${CSS.escape(data.id)}"]`);
    if (el) {
      const isSelf = isOwnMessage({ nickname: data.nickname, clientId: data.clientId });
      el.className = 'msg system';
      el.removeAttribute('data-mid');
      el.innerHTML = `<div class="msg-bubble">${escapeHtml(isSelf ? '你' : data.nickname)} 撤回了一条消息</div>`;
    }
  });

  // ---------- @ 自动补全 ----------
  const acBox = document.createElement('div');
  acBox.className = 'ac-box';
  acBox.hidden = true;
  document.querySelector('.inputbar').appendChild(acBox);
  let acOpen = false;
  let acItems = [];
  let acIndex = 0;
  let acTokenStart = -1;

  function closeAutocomplete() {
    acOpen = false;
    acBox.hidden = true;
    acItems = [];
    acTokenStart = -1;
  }

  // 光标前最近一个 @token
  function acDetect() {
    const pos = msgInput.selectionStart;
    const before = msgInput.value.slice(0, pos);
    const m = before.match(/@([^\s@]{0,20})$/);
    if (!m) return null;
    return { start: pos - m[0].length, keyword: m[1] };
  }

  function acRefresh() {
    const hit = acDetect();
    if (!hit) {
      closeAutocomplete();
      return;
    }
    const kw = hit.keyword.toLowerCase();
    acItems = latestMembers
      .filter((m) => (m.nickname || m) !== myNickname)
      .map((m) => m.nickname || m)
      .filter((nick) => !kw || nick.toLowerCase().includes(kw))
      .slice(0, 8);
    if (!acItems.length) {
      closeAutocomplete();
      return;
    }
    acTokenStart = hit.start;
    acOpen = true;
    acIndex = 0;
    acBox.innerHTML = acItems.map((nick, i) =>
      `<div class="ac-item${i === acIndex ? ' active' : ''}" data-i="${i}">${escapeHtml(nick)}</div>`
    ).join('');
    acBox.hidden = false;
    acBox.querySelectorAll('.ac-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 保持输入框焦点
        acIndex = Number(el.dataset.i);
        acSelect();
      });
    });
  }

  function acMove(delta) {
    acIndex = (acIndex + delta + acItems.length) % acItems.length;
    acBox.querySelectorAll('.ac-item').forEach((el, i) => el.classList.toggle('active', i === acIndex));
  }

  function acSelect() {
    const nick = acItems[acIndex];
    if (!nick) return;
    const pos = msgInput.selectionStart;
    msgInput.value = msgInput.value.slice(0, acTokenStart) + '@' + nick + ' ' + msgInput.value.slice(pos);
    const caret = acTokenStart + nick.length + 2;
    msgInput.setSelectionRange(caret, caret);
    closeAutocomplete();
    msgInput.focus();
  }

  msgInput.addEventListener('input', acRefresh);
  msgInput.addEventListener('click', acRefresh);
  msgInput.addEventListener('blur', () => setTimeout(closeAutocomplete, 150));

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
      setHint('文件超过 200MB 大小限制', 'error');
      return;
    }
    if (file.size <= 0) {
      setHint('空文件无法上传', 'error');
      return;
    }
    setHint(`正在上传 ${file.name} … 准备中`);
    try {
      // 1) 初始化（同一文件会返回已收分片 → 续传）
      const init = await postJson('/upload/init', {
        fileName: encodeURIComponent(file.name),
        size: file.size,
        lastModified: file.lastModified
      });
      if (!init || !init.ok) {
        setHint((init && init.error) || '初始化上传失败', 'error');
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
          setHint(`上传中断（第 ${i + 1}/${totalChunks} 片）。重新选择同一文件可断点续传`, 'error');
          return;
        }
        const done = already + (i - sentSet.size + 1);
        setHint(`正在上传 ${file.name} … ${Math.round((done / totalChunks) * 100)}%`);
      }

      // 3) 合并 + 进聊天
      const fd2 = new FormData();
      fd2.append('uploadId', uploadId);
      fd2.append('originalName', encodeURIComponent(file.name));
      fd2.append('totalChunks', String(totalChunks));
      fd2.append('size', String(file.size));
      fd2.append('nickname', myNickname);
      fd2.append('clientId', myClientId);
      fd2.append('room', currentRoom);
      const comp = await fetch('/upload/complete', { method: 'POST', body: fd2 })
        .then((r) => r.json().catch(() => null)).catch(() => null);
      if (!comp || !comp.ok) {
        setHint((comp && comp.error) || '合并文件失败', 'error');
        return;
      }
      setHint(`已发送文件 ${file.name}`, 'success');
    } catch (e) {
      setHint(`上传失败：${e.message || '未知错误'}`, 'error');
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

  // ---------- 深色 / 浅色主题切换 ----------
  const THEME_STORAGE_KEY = 'localsend-theme';
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch (_) { /* ignore */ }
    });
  }

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
