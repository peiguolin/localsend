/* call 媒体片：RTCPeerConnection 管理（ensure/remove/close）、摄像头开关与前后切换、
 * 重协商、设备采集、本地预览、收尾清理。跨片经内部总线 K（app._call）共享。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const K = app._call;
  const socket = app.socket;
  const state = app.state;

  const callAudios = K.callAudios;
  const callVideos = K.callVideos;
  const callCamBtn = K.callCamBtn;
  const callFlipBtn = K.callFlipBtn;

  // ---------- RTCPeerConnection 管理（每对端一条） ----------
  function ensurePeer(peerId) {
    let p = state.peers.get(peerId);
    if (p) return p;
    p = new RTCPeerConnection(K.RTC_CONFIG);
    if (state.localStream) state.localStream.getTracks().forEach((t) => p.addTrack(t, state.localStream));
    if (state.videoMode) {
      // 视频模式：每路远端一个视频 tile（音视频在同一 <video> 上播放）
      const nickname = (state.roster.find((m) => m.id === peerId) || {}).nickname || '对方';
      const tile = K.createRemoteTile(peerId, nickname);
      callVideos.appendChild(tile);
      const videoEl = tile.querySelector('video');
      p.ontrack = (e) => {
        if (!e.streams || !e.streams[0]) return;
        videoEl.srcObject = e.streams[0];
        videoEl.play().catch(() => {});
        const hasVideo = e.streams[0].getVideoTracks().length > 0;
        tile.classList.toggle('no-video', !hasVideo || K.hiddenRemoteVideos.has(peerId));
        K.setupSpeakerMeter(peerId, e.streams[0]);
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
    const tile = K.getRemoteTile(peerId);
    if (tile) tile.remove();
    K.hiddenRemoteVideos.delete(peerId);
    const meter = K.speakerAnalysers.get(peerId);
    if (meter) {
      try { meter.src.disconnect(); meter.ctx.close(); } catch (_) {}
      K.speakerAnalysers.delete(peerId);
    }
    if (state.activeSpeakerId === peerId) state.activeSpeakerId = '';
  }

  function closeAllPeers() {
    for (const id of Array.from(state.peers.keys())) removePeer(id);
    state.peers.clear();
  }

  // 摄像头开关：增/删视频轨道并触发重协商
  async function toggleCamera() {
    if (!state.localStream || state.callState !== 'active') return;
    if (state.camOn) {
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
    K.stopCallTimer();
    K.stopRingTone();
    closeAllPeers();
    K.stopSpeakerMeters();
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      state.localStream = null;
    }
    callAudios.innerHTML = '';
    callVideos.innerHTML = '';
    K.hiddenRemoteVideos.clear();
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
    K.hideCallModal();
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

  Object.assign(K, {
    ensurePeer, removePeer, closeAllPeers,
    toggleCamera, flipCamera, maybeRenegotiate,
    cleanupCall, failCall, getMedia, setupLocalPreview, refreshLocalPreview
  });
})();
