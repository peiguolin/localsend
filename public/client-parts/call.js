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
  const callVideos = document.getElementById('callVideos');
  const callAcceptBtn = document.getElementById('callAcceptBtn');
  const callRejectBtn = document.getElementById('callRejectBtn');
  const callMuteBtn = document.getElementById('callMuteBtn');
  const callCamBtn = document.getElementById('callCamBtn');
  const callFlipBtn = document.getElementById('callFlipBtn');
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
    callCamBtn.hidden = true;
    callFlipBtn.hidden = true;
    callEndBtn.hidden = true;
    callStatus.hidden = false;
    callStatus.textContent = '';
    callTitle.textContent = '语音通话';
    callMembers.innerHTML = '';
    callVideos.hidden = true;
    callVideos.innerHTML = '';
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
    callCamBtn.hidden = !(uiState === 'active' && state.videoMode);
    callCamBtn.textContent = state.camOn ? '关摄像头' : '开摄像头';
    callFlipBtn.hidden = !(uiState === 'active' && state.videoMode && state.camOn);
    callEndBtn.hidden = false;
    callEndBtn.textContent = (uiState === 'ringing') ? '取消' : '挂断';
    const mode = state.videoMode ? '视频' : '语音';
    if (uiState === 'ringing') {
      callTitle.textContent = '正在呼叫…';
      callStatus.textContent = '等待接听';
      callStatus.hidden = false;
    } else if (uiState === 'incoming') {
      const who = state.roster[0] ? state.roster[0].nickname : '';
      const group = state.ringingTargets.length > 1;
      callTitle.textContent = '来电';
      callStatus.textContent = (group ? `${who} 邀请你加入群聊${mode}通话` : `${who} 邀请你${mode}通话`);
      callStatus.hidden = false;
    } else if (uiState === 'active') {
      callTitle.textContent = state.videoMode
        ? (state.roster.length > 2 ? `视频通话中 (${state.roster.length} 人)` : '视频通话中')
        : (state.roster.length > 2 ? `通话中 (${state.roster.length} 人)` : '通话中');
      callStatus.hidden = true;
      callTimerEl.hidden = false;
    }
    // 视频模式通话中：显示视频网格（tile 自带名字），隐藏成员 chips
    const showGrid = state.videoMode && uiState === 'active';
    callVideos.hidden = !showGrid;
    callMembers.hidden = showGrid;
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
    if (state.videoMode) {
      // 视频模式：每路远端一个视频 tile（音视频在同一 <video> 上播放）
      const nickname = (state.roster.find((m) => m.id === peerId) || {}).nickname || '对方';
      const tile = createRemoteTile(peerId, nickname);
      callVideos.appendChild(tile);
      const videoEl = tile.querySelector('video');
      p.ontrack = (e) => {
        if (!e.streams || !e.streams[0]) return;
        videoEl.srcObject = e.streams[0];
        videoEl.play().catch(() => {});
        const hasVideo = e.streams[0].getVideoTracks().length > 0;
        tile.classList.toggle('no-video', !hasVideo || hiddenRemoteVideos.has(peerId));
        setupSpeakerMeter(peerId, e.streams[0]);
      };
    } else {
      // 语音模式：每路远端一个隐藏 <audio>（原逻辑，独立播放）
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
    }
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
    // 视频轨道增删等触发的重协商入口
    p.onnegotiationneeded = () => maybeRenegotiate(p, peerId);
    state.peers.set(peerId, p);
    return p;
  }

  function removePeer(peerId) {
    const p = state.peers.get(peerId);
    if (p) {
      try { p.onicecandidate = null; p.ontrack = null; p.onconnectionstatechange = null; p.onnegotiationneeded = null; } catch (_) {}
      try { p.close(); } catch (_) {}
      state.peers.delete(peerId);
    }
    const audioEl = callAudios.querySelector(`audio[data-peer="${peerId}"]`);
    if (audioEl) audioEl.remove();
    const tile = getRemoteTile(peerId);
    if (tile) tile.remove();
    hiddenRemoteVideos.delete(peerId);
    const meter = speakerAnalysers.get(peerId);
    if (meter) {
      try { meter.src.disconnect(); meter.ctx.close(); } catch (_) {}
      speakerAnalysers.delete(peerId);
    }
    if (state.activeSpeakerId === peerId) state.activeSpeakerId = '';
  }

  function closeAllPeers() {
    for (const id of Array.from(state.peers.keys())) removePeer(id);
    state.peers.clear();
  }

  // ---------- 视频通话（方案 B：全员网格 + 说话人高亮 + 每路可开关 + 重协商） ----------
  const SPEAKER_THRESHOLD = 8;          // 音量阈值（RMS），低于视为静音
  const speakerAnalysers = new Map();   // peerId -> {ctx, src, analyser, data}
  const hiddenRemoteVideos = new Set(); // 本地隐藏的远端视频（仅本地生效，音频不受影响）

  // 音量均方根（供说话人检测与单测）
  function computeRms(data) {
    if (!data || !data.length) return 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  }

  // 渲染一个远端成员 tile（<video> + 名字 + 未开摄像头占位 + 隐藏按钮）
  function createRemoteTile(peerId, nickname) {
    const tile = document.createElement('div');
    tile.className = 'call-video-tile';
    tile.dataset.peer = peerId;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.className = 'call-video';
    const name = document.createElement('div');
    name.className = 'call-video-name';
    name.textContent = nickname || '对方';
    const off = document.createElement('div');
    off.className = 'call-video-off';
    off.textContent = '📷 未开摄像头';
    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'call-video-mute';
    hideBtn.title = '隐藏/显示该路视频';
    hideBtn.textContent = '🙈';
    hideBtn.addEventListener('click', () => {
      if (hiddenRemoteVideos.has(peerId)) {
        hiddenRemoteVideos.delete(peerId);
        video.hidden = false;
        tile.classList.remove('no-video');
      } else {
        hiddenRemoteVideos.add(peerId);
        video.hidden = true;
        tile.classList.add('no-video');
      }
    });
    tile.appendChild(video);
    tile.appendChild(name);
    tile.appendChild(off);
    tile.appendChild(hideBtn);
    return tile;
  }

  function getRemoteTile(peerId) {
    return callVideos.querySelector(`[data-peer="${CSS.escape(peerId)}"]`);
  }

  // 说话人检测：为每路远端流挂音量分析（不连 destination，避免双路播放）
  function setupSpeakerMeter(peerId, stream) {
    if (!state.videoMode) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      speakerAnalysers.set(peerId, { ctx, src, analyser, data: new Uint8Array(analyser.frequencyBinCount) });
    } catch (_) {}
  }

  function stopSpeakerMeters() {
    for (const [, m] of speakerAnalysers) {
      try { m.src.disconnect(); m.ctx.close(); } catch (_) {}
    }
    speakerAnalysers.clear();
    state.activeSpeakerId = '';
  }

  function setActiveSpeaker(peerId) {
    state.activeSpeakerId = peerId || '';
    callVideos.querySelectorAll('.call-video-tile').forEach((t) => {
      if (t.classList.contains('local')) return;
      t.classList.toggle('speaking', t.dataset.peer === state.activeSpeakerId);
    });
  }

  function tickActiveSpeaker() {
    if (!state.videoMode || state.callState !== 'active') return;
    let best = null;
    let bestLevel = 0;
    for (const [peerId, m] of speakerAnalysers) {
      try { m.analyser.getByteFrequencyData(m.data); } catch (_) { continue; }
      const level = computeRms(m.data);
      if (level > SPEAKER_THRESHOLD && level > bestLevel) { best = peerId; bestLevel = level; }
    }
    setActiveSpeaker(best);
  }

  // 摄像头开关：增/删视频轨道并触发重协商
  async function toggleCamera() {
    if (!state.localStream || state.callState !== 'active') return;
    if (state.camOn) {
      // 关闭：从所有 PC 移除视频轨道并停止摄像头
      const vids = state.localStream.getVideoTracks().slice();
      for (const t of vids) {
        for (const p of state.peers.values()) {
          try {
            const sender = (p.getSenders ? p.getSenders() : []).find((s) => s.track === t);
            if (sender) p.removeTrack(sender);
          } catch (_) {}
        }
        try { t.stop(); } catch (_) {}
        try { state.localStream.removeTrack(t); } catch (_) {}
      }
      state.camOn = false;
      callCamBtn.textContent = '开摄像头';
      callFlipBtn.hidden = true;
      refreshLocalPreview();
    } else {
      try {
        const v = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: state.camFacing, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        const vt = v.getVideoTracks()[0];
        if (!vt) { app.setHint('无法打开摄像头', 'error'); return; }
        state.localStream.addTrack(vt);
        for (const p of state.peers.values()) {
          try { p.addTrack(vt, state.localStream); } catch (_) {}
        }
        state.camOn = true;
        callCamBtn.textContent = '关摄像头';
        callFlipBtn.hidden = false;
        refreshLocalPreview();
      } catch (_) {
        app.setHint('无法打开摄像头（权限被拒或无摄像头）', 'error');
        return;
      }
    }
    // 轨道变更 → 对每条连接重协商
    for (const [peerId, p] of state.peers) maybeRenegotiate(p, peerId);
  }

  // 摄像头前后切换：用新 facingMode 重新采集视频轨道并替换（含各 PC 轨道 + 重协商）
  async function flipCamera() {
    if (!state.videoMode || !state.camOn || state.callState !== 'active') return;
    const next = state.camFacing === 'user' ? 'environment' : 'user';
    try {
      const v = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: next, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const vt = v.getVideoTracks()[0];
      if (!vt) { app.setHint('该设备没有其他摄像头', 'error'); return; }
      // 移除旧视频轨道（各 PC sender + localStream）并停止
      const oldTracks = state.localStream.getVideoTracks().slice();
      for (const old of oldTracks) {
        for (const p of state.peers.values()) {
          try {
            const sender = (p.getSenders ? p.getSenders() : []).find((s) => s.track === old);
            if (sender) p.removeTrack(sender);
          } catch (_) {}
        }
        try { state.localStream.removeTrack(old); } catch (_) {}
        try { old.stop(); } catch (_) {}
      }
      // 挂上新轨道
      state.localStream.addTrack(vt);
      for (const p of state.peers.values()) {
        try { p.addTrack(vt, state.localStream); } catch (_) {}
      }
      state.camFacing = next;
      refreshLocalPreview();
      for (const [peerId, p] of state.peers) maybeRenegotiate(p, peerId);
    } catch (_) {
      app.setHint('无法切换摄像头（无可用摄像头或权限被拒）', 'error');
    }
  }

  // ---------- 重协商（视频轨道增删；简单完美协商：发起方在 stable 才发 offer） ----------
  function maybeRenegotiate(p, peerId) {
    if (!p || state.callState !== 'active') return;
    if (p.signalingState && p.signalingState !== 'stable') { p._renegotiateQueued = true; return; }
    if (p._negotiating) { p._renegotiateQueued = true; return; }
    renegotiate(p, peerId);
  }

  async function renegotiate(p, peerId) {
    if (!p) return;
    p._negotiating = true;
    try {
      const offer = await p.createOffer();
      await p.setLocalDescription(offer);
      socket.emit('rtc_offer', { toId: peerId, roomId: state.roomId, sdp: p.localDescription });
    } catch (_) { /* 忽略 */ }
    p._negotiating = false;
    if (p._renegotiateQueued) { p._renegotiateQueued = false; maybeRenegotiate(p, peerId); }
  }

  // 收尾：清理媒体/连接/UI/铃声，回到 idle
  function cleanupCall(message) {
    stopCallTimer();
    stopRingTone();
    closeAllPeers();
    stopSpeakerMeters();
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      state.localStream = null;
    }
    callAudios.innerHTML = '';
    callVideos.innerHTML = '';
    hiddenRemoteVideos.clear();
    state.videoMode = false;
    state.camOn = false;
    state.camFacing = 'user';
    state.activeSpeakerId = '';
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

  // 媒体采集：视频通话先取音频再叠加视频（任一被拒/无摄像头 → 自动降级纯语音）
  async function getMedia(videoWanted) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('浏览器不支持麦克风/摄像头（需 HTTPS + 现代浏览器）');
    }
    const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!videoWanted) return audio;
    try {
      const v = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const vt = v.getVideoTracks()[0];
      if (vt) audio.addTrack(vt);
    } catch (_) { /* 无摄像头/权限被拒 → 保持纯音频 */ }
    return audio;
  }

  // 本地预览：视频模式下通话开始后创建（muted 防啸叫）
  function setupLocalPreview() {
    if (!state.videoMode || !state.localStream) return;
    if (!callVideos.querySelector('.call-video-tile.local')) {
      const tile = document.createElement('div');
      tile.className = 'call-video-tile local';
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.srcObject = state.localStream;
      const name = document.createElement('div');
      name.className = 'call-video-name';
      name.textContent = '我';
      tile.appendChild(video);
      tile.appendChild(name);
      callVideos.appendChild(tile);
    }
    refreshLocalPreview();
  }

  function refreshLocalPreview() {
    if (!state.videoMode) return;
    const tile = callVideos.querySelector('.call-video-tile.local');
    if (!tile) return;
    const video = tile.querySelector('video');
    if (video) video.srcObject = state.localStream;
    const has = !!(state.camOn && state.localStream && state.localStream.getVideoTracks().length);
    tile.classList.toggle('no-video', !has);
  }

  // ---------- 对外动作 ----------
  // 主叫：对一批目标发起通话（1:1 即 targets=[1人]）；videoMode=true 发起视频通话
  async function startCall(targets, videoMode) {
    if (state.callState !== 'idle') return;
    const list = (targets || []).filter((t) => t && t.id && t.id !== state.myId);
    if (!list.length) return;
    state.myRole = 'caller';
    state.callerId = state.myId;
    state.videoMode = !!videoMode;
    state.camOn = !!videoMode;
    state.roster = [{ id: state.myId, nickname: state.myNickname }];
    state.ringingTargets = list.map((t) => ({ id: t.id, nickname: t.nickname || '对方' }));
    state.callState = 'ringing';
    setCallUI('ringing');
    startRingTone();
    try {
      state.localStream = await getMedia(state.videoMode);
    } catch (_) {
      failCall('无法获取麦克风权限，请检查浏览器设置');
      return;
    }
    // 请求了视频但被降级成纯音频（无摄像头/被拒）→ 以实际轨道为准
    if (state.videoMode && !state.localStream.getVideoTracks().length) state.camOn = false;
    setupLocalPreview();
    socket.emit('call_user', { targets: list.map((t) => t.id), video: state.videoMode });
  }

  // 被叫：接听（接听后作为新成员向既有成员发 offer）
  async function acceptCall() {
    if (state.callState !== 'incoming') return;
    stopRingTone();
    try {
      state.localStream = await getMedia(state.videoMode);
    } catch (_) {
      socket.emit('call_reject', { roomId: state.roomId });
      failCall('无法获取麦克风权限，已拒绝通话');
      return;
    }
    if (state.videoMode && !state.localStream.getVideoTracks().length) state.camOn = false;
    setupLocalPreview();
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
    state.videoMode = data.video === true;
    state.camOn = state.videoMode;
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
        const n = new Notification(`${who} ${state.videoMode ? (group ? '邀请你加入群聊视频通话' : '邀请你视频通话') : (group ? '邀请你加入群聊通话' : '邀请你语音通话')}`, { body: '点击接听', icon: app.drawFavicon(0), tag: 'call' });
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
      // 重协商：若本地正持有未完成的 offer → rollback 后采纳对方（避免 glare）
      if (p.signalingState === 'have-local-offer') {
        try { await p.setLocalDescription({ type: 'rollback' }); } catch (_) {}
      }
      await p.setRemoteDescription(data.sdp);
      const answer = await p.createAnswer();
      await p.setLocalDescription(answer);
      socket.emit('rtc_answer', { toId: fromId, roomId: state.roomId, sdp: p.localDescription });
    } catch (_) { /* 忽略 */ }
  });

  socket.on('rtc_answer', async (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const p = state.peers.get(data.fromId);
    if (!p) return;
    try {
      await p.setRemoteDescription(data.sdp);
      // 若有排队的重协商（前一条 offer 未应答期间发生的轨道变更）→ 补发
      if (p._renegotiateQueued) { p._renegotiateQueued = false; maybeRenegotiate(p, data.fromId); }
    } catch (_) { /* 状态不符时忽略 */ }
  });

  socket.on('rtc_ice', async (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const p = state.peers.get(data.fromId);
    if (!p) return;
    try { await p.addIceCandidate(data.candidate); } catch (_) { /* 候选可能已过期 */ }
  });

  // 说话人检测循环（仅视频模式活跃；无 AudioContext 环境静默跳过）
  setInterval(tickActiveSpeaker, 250);

  // 按钮绑定（多选呼叫按钮 groupCallBtn/callSelectedBtn/callSelectionClearBtn 在 members.js 绑定）
  callAcceptBtn.addEventListener('click', acceptCall);
  callRejectBtn.addEventListener('click', rejectCall);
  callMuteBtn.addEventListener('click', toggleMute);
  callCamBtn.addEventListener('click', toggleCamera);
  callFlipBtn.addEventListener('click', flipCamera);
  callEndBtn.addEventListener('click', endCall);

  // 断线清理
  socket.on('disconnect', () => {
    if (state.callState !== 'idle') cleanupCall('连接断开，通话结束');
  });

  // 暴露给壳与其他分片（日历"一键拉会"等）
  Object.assign(app, {
    startCall,
    callTargets: (targetIds) => startCall((targetIds || []).map((id) => ({ id, nickname: '' }))),
    toggleCamera,
    flipCamera,
    // 视频模块测试钩子（单测用；生产路径由音量检测驱动）
    __videoTest: { computeRms, setActiveSpeaker, tickActiveSpeaker, createRemoteTile }
  });
})();
