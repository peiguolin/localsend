/* 通话分片：WebRTC Mesh 多方语音通话（独立于 client.js 壳）。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之后加载。
 * 跨模块依赖：壳的 setHint / drawFavicon，经 window.chatApp（app.*）事件期惰性调用。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const socket = app.socket;
  const state = app.state;

  // ---------- DOM 引用 ----------
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

  // ---------- 多方语音通话（WebRTC Mesh 房间模型） ----------
  // 状态机：idle → ringing(主叫等待) / incoming(被叫来电) → active(通话中) → idle
  // Mesh：每个成员与房间内其他每位成员各建一条 RTCPeerConnection（state.peers: Map<peerId, pc>）
  // 通话状态（state.callState / state.roster / state.peers / state.localStream …）见 state.js

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
    state.roster.forEach((m) => {
      const chip = document.createElement('span');
      chip.className = 'call-chip' + (m.id === state.myId ? ' me' : '');
      chip.textContent = m.nickname;
      callMembers.appendChild(chip);
    });
    state.ringingTargets.forEach((t) => {
      if (!state.roster.some((m) => m.id === t.id)) {
        const chip = document.createElement('span');
        chip.className = 'call-chip ringing';
        chip.textContent = t.nickname + '…';
        callMembers.appendChild(chip);
      }
    });
  }

  function setCallUI(uiState) {
    showCallModal();
    callAcceptBtn.hidden = !(uiState === 'incoming');
    callRejectBtn.hidden = !(uiState === 'incoming');
    callMuteBtn.hidden = !(uiState === 'active');
    callMuteBtn.textContent = state.muted ? '取消静音' : '静音';
    callEndBtn.hidden = false;
    callEndBtn.textContent = (uiState === 'ringing') ? '取消' : '挂断';
    if (uiState === 'ringing') {
      callTitle.textContent = '正在呼叫…';
      callStatus.textContent = '等待接听';
      callStatus.hidden = false;
    } else if (uiState === 'incoming') {
      const who = state.roster[0] ? state.roster[0].nickname : '';
      const group = state.ringingTargets.length > 1;
      callTitle.textContent = '来电';
      callStatus.textContent = (group ? `${who} 邀请你加入群聊通话` : `${who} 邀请你语音通话`);
      callStatus.hidden = false;
    } else if (uiState === 'active') {
      callTitle.textContent = state.roster.length > 2 ? `通话中 (${state.roster.length} 人)` : '通话中';
      callStatus.hidden = true;
      callTimerEl.hidden = false;
    }
    renderCallMembers();
  }

  function startCallTimer() {
    state.callSec = 0;
    callTimerEl.textContent = '00:00';
    clearInterval(state.callTimer);
    state.callTimer = setInterval(() => {
      state.callSec++;
      callTimerEl.textContent = fmtDuration(state.callSec);
    }, 1000);
  }

  function stopCallTimer() {
    clearInterval(state.callTimer);
    state.callTimer = null;
    state.callSec = 0;
  }

  // ---------- 铃声（Web Audio 模拟来电振铃） ----------
  function startRingTone() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!state.ringCtx) state.ringCtx = new AC();
      if (state.ringCtx.state === 'suspended') state.ringCtx.resume();
      state.ringTimer = setInterval(() => {
        const t0 = state.ringCtx.currentTime;
        [880, 1174].forEach((freq, i) => {
          const osc = state.ringCtx.createOscillator();
          const gain = state.ringCtx.createGain();
          const tt = t0 + i * 0.14;
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, tt);
          gain.gain.exponentialRampToValueAtTime(0.16, tt + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, tt + 0.22);
          osc.connect(gain).connect(state.ringCtx.destination);
          osc.start(tt);
          osc.stop(tt + 0.24);
        });
      }, 1400);
    } catch (_) { /* 忽略铃声失败 */ }
  }

  function stopRingTone() {
    clearInterval(state.ringTimer);
    state.ringTimer = null;
  }

  // ---------- RTCPeerConnection 管理（每对端一条） ----------
  function ensurePeer(peerId) {
    let p = state.peers.get(peerId);
    if (p) return p;
    p = new RTCPeerConnection(RTC_CONFIG);
    if (state.localStream) state.localStream.getTracks().forEach((t) => p.addTrack(t, state.localStream));
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
      if (e.candidate && state.callState === 'active' && state.roomId) {
        socket.emit('rtc_ice', { toId: peerId, roomId: state.roomId, candidate: e.candidate });
      }
    };
    p.onconnectionstatechange = () => {
      if (p.connectionState === 'failed' || p.connectionState === 'disconnected') {
        // 单路连接失败：只移除这一路，不结束整个通话
        removePeer(peerId);
      }
    };
    state.peers.set(peerId, p);
    return p;
  }

  function removePeer(peerId) {
    const p = state.peers.get(peerId);
    if (p) {
      try { p.onicecandidate = null; p.ontrack = null; p.onconnectionstatechange = null; } catch (_) {}
      try { p.close(); } catch (_) {}
      state.peers.delete(peerId);
    }
    const audioEl = callAudios.querySelector(`audio[data-peer="${peerId}"]`);
    if (audioEl) audioEl.remove();
  }

  function closeAllPeers() {
    for (const id of Array.from(state.peers.keys())) removePeer(id);
    state.peers.clear();
  }

  // 收尾：清理媒体/连接/UI/铃声，回到 idle
  function cleanupCall(message) {
    stopCallTimer();
    stopRingTone();
    closeAllPeers();
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      state.localStream = null;
    }
    callAudios.innerHTML = '';
    state.roomId = '';
    state.callerId = '';
    state.myRole = '';
    state.roster = [];
    state.ringingTargets = [];
    state.muted = false;
    state.callState = 'idle';
    hideCallModal();
    if (message) app.setHint(message, 'success');
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
    if (state.callState !== 'idle') return;
    const list = (targets || []).filter((t) => t && t.id && t.id !== state.myId);
    if (!list.length) return;
    state.myRole = 'caller';
    state.callerId = state.myId;
    state.roster = [{ id: state.myId, nickname: state.myNickname }];
    state.ringingTargets = list.map((t) => ({ id: t.id, nickname: t.nickname || '对方' }));
    state.callState = 'ringing';
    setCallUI('ringing');
    startRingTone();
    try {
      state.localStream = await getMic();
    } catch (_) {
      failCall('无法获取麦克风权限，请检查浏览器设置');
      return;
    }
    socket.emit('call_user', { targets: list.map((t) => t.id) });
  }

  // 被叫：接听（接听后作为新成员向既有成员发 offer）
  async function acceptCall() {
    if (state.callState !== 'incoming') return;
    stopRingTone();
    try {
      state.localStream = await getMic();
    } catch (_) {
      socket.emit('call_reject', { roomId: state.roomId });
      failCall('无法获取麦克风权限，已拒绝通话');
      return;
    }
    state.callState = 'active';
    socket.emit('call_accept', { roomId: state.roomId });
    startCallTimer();
  }

  // 被叫：拒绝
  function rejectCall() {
    if (state.callState !== 'incoming') return;
    socket.emit('call_reject', { roomId: state.roomId });
    stopRingTone();
    hideCallModal();
    state.callState = 'idle';
    state.roster = [];
    state.ringingTargets = [];
  }

  // 静音切换
  function toggleMute() {
    if (!state.localStream) return;
    state.muted = !state.muted;
    state.localStream.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
    callMuteBtn.textContent = state.muted ? '取消静音' : '静音';
  }

  // 挂断 / 取消（房间模型统一走 call_end）
  function endCall() {
    if (state.callState === 'idle') return;
    if (state.callState === 'incoming') { rejectCall(); return; }
    if (state.roomId) socket.emit('call_end', { roomId: state.roomId });
    cleanupCall();
  }

  // ---------- 信令监听 ----------
  socket.on('incoming_call', (data) => {
    if (state.callState !== 'idle') {
      // 忙线：直接拒绝（正常不会发生，服务端已过滤；防竞态）
      socket.emit('call_reject', { roomId: data.roomId });
      return;
    }
    state.roomId = data.roomId || '';
    state.callerId = data.fromId || '';
    state.myRole = 'callee';
    state.roster = (data.roster && data.roster.length ? data.roster : [{ id: data.fromId, nickname: data.fromName }]);
    state.ringingTargets = data.targets || [];
    state.callState = 'incoming';
    setCallUI('incoming');
    startRingTone();
    // 页面在后台也提醒
    if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const who = state.roster[0] ? state.roster[0].nickname : '';
        const group = state.ringingTargets.length > 1;
        const n = new Notification(`${who} ${group ? '邀请你加入群聊通话' : '邀请你语音通话'}`, { body: '点击接听', icon: app.drawFavicon(0), tag: 'call' });
        n.onclick = () => { window.focus(); };
      } catch (_) {}
    }
  });

  socket.on('call_ringing', (data) => {
    if (state.callState !== 'ringing') return;
    state.roomId = data.roomId || state.roomId;
    if (Array.isArray(data.targets)) {
      state.ringingTargets = data.targets.map((t) => ({ id: t.id, nickname: t.nickname || '对方' }));
    }
    setCallUI('ringing');
    // 有忙线/离线目标 → 提示
    const busyNames = (data.busy || []).map((b) => b.nickname).filter(Boolean);
    const offlineNames = (data.offline || []).map((b) => b.nickname).filter(Boolean);
    if (busyNames.length || offlineNames.length) {
      const parts = [];
      if (busyNames.length) parts.push(`${busyNames.join('、')} 忙线`);
      if (offlineNames.length) parts.push(`${offlineNames.join('、')} 不在线`);
      app.setHint('已跳过：' + parts.join('，'), '');
    }
  });

  // 有人加入房间：更新名单；新成员（自己）向所有既有成员发 offer
  socket.on('room_member_joined', async (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const prevRoster = state.roster;
    state.roster = (data.members || []).filter((m) => m);
    const newMember = data.member;
    const iAmNew = newMember && newMember.id === state.myId;
    if (state.callState === 'ringing') {
      // 主叫：第一个成员接听 → 通话开始
      state.callState = 'active';
      stopRingTone();
      setCallUI('active');
      startCallTimer();
    } else {
      setCallUI(state.callState);
    }
    if (iAmNew && state.localStream) {
      // 新成员：主动向每个既有成员发 offer（避免 glare）
      for (const m of state.roster) {
        if (m.id === state.myId) continue;
        try {
          const p = ensurePeer(m.id);
          const offer = await p.createOffer();
          await p.setLocalDescription(offer);
          socket.emit('rtc_offer', { toId: m.id, roomId: state.roomId, sdp: p.localDescription });
        } catch (_) {}
      }
    }
    // 主叫的振铃列表：移除已接听的人
    if (state.myRole === 'caller' && iAmNew === false) {
      state.ringingTargets = state.ringingTargets.filter((t) => t.id !== (newMember && newMember.id));
    }
    void prevRoster;
  });

  // 有人离开房间
  socket.on('room_member_left', (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const leaverId = data.memberId;
    removePeer(leaverId);
    state.roster = state.roster.filter((m) => m.id !== leaverId);
    if (state.roster.length <= 1) {
      // 只剩自己（或空了）→ 结束
      cleanupCall(data.reason === 'offline' ? '对方已离线，通话结束' : '通话已结束');
      return;
    }
    setCallUI('active');
    if (data.memberName) app.setHint(`${data.memberName} 离开了通话`, 'success');
  });

  socket.on('call_rejected', (data) => {
    if (state.callState === 'ringing') {
      app.setHint(`${(data && data.memberName) || '有人'} 拒绝了通话`, '');
      if (data && data.memberId) {
        state.ringingTargets = state.ringingTargets.filter((t) => t.id !== data.memberId);
        renderCallMembers();
      }
    }
  });

  socket.on('call_failed', (data) => {
    if (state.callState === 'ringing' || state.callState === 'incoming') {
      failCall((data && data.error) || '无法建立通话');
    }
  });

  socket.on('call_cancelled', () => {
    if (state.callState === 'incoming') {
      stopRingTone();
      hideCallModal();
      state.callState = 'idle';
      state.roster = [];
      state.ringingTargets = [];
      app.setHint('对方已取消通话', 'success');
    }
  });

  socket.on('rtc_offer', async (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const fromId = data.fromId;
    if (!fromId || fromId === state.myId) return;
    try {
      const p = ensurePeer(fromId);
      if (p.remoteDescription) return; // 已有协商
      await p.setRemoteDescription(data.sdp);
      const answer = await p.createAnswer();
      await p.setLocalDescription(answer);
      socket.emit('rtc_answer', { toId: fromId, roomId: state.roomId, sdp: p.localDescription });
    } catch (_) { /* 忽略 */ }
  });

  socket.on('rtc_answer', async (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const p = state.peers.get(data.fromId);
    if (!p || p.remoteDescription) return;
    try { await p.setRemoteDescription(data.sdp); } catch (_) { /* 忽略 */ }
  });

  socket.on('rtc_ice', async (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const p = state.peers.get(data.fromId);
    if (!p) return;
    try { await p.addIceCandidate(data.candidate); } catch (_) { /* 候选可能已过期 */ }
  });

  // 按钮绑定（多选呼叫按钮 groupCallBtn/callSelectedBtn/callSelectionClearBtn 在 members.js 绑定）
  callAcceptBtn.addEventListener('click', acceptCall);
  callRejectBtn.addEventListener('click', rejectCall);
  callMuteBtn.addEventListener('click', toggleMute);
  callEndBtn.addEventListener('click', endCall);

  // 断线清理
  socket.on('disconnect', () => {
    if (state.callState !== 'idle') cleanupCall('连接断开，通话结束');
  });

  // 暴露给壳与其他分片（日历"一键拉会"等）
  Object.assign(app, {
    startCall,
    callTargets: (targetIds) => startCall((targetIds || []).map((id) => ({ id, nickname: '' })))
  });
})();
