/* call UI 片：通话弹窗界面、计时、振铃、成员 chips、远端视频 tile 与说话人检测。
 * 跨片经内部总线 K（app._call）共享 DOM 句柄与函数。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const K = app._call;
  const state = app.state;

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

  function fmtDuration(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

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

  // ---------- 视频网格：远端 tile / 说话人检测 ----------
  function computeRms(data) {
    if (!data || !data.length) return 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  }

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
      if (K.hiddenRemoteVideos.has(peerId)) {
        K.hiddenRemoteVideos.delete(peerId);
        video.hidden = false;
        tile.classList.remove('no-video');
      } else {
        K.hiddenRemoteVideos.add(peerId);
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
      K.speakerAnalysers.set(peerId, { ctx, src, analyser, data: new Uint8Array(analyser.frequencyBinCount) });
    } catch (_) {}
  }

  function stopSpeakerMeters() {
    for (const [, m] of K.speakerAnalysers) {
      try { m.src.disconnect(); m.ctx.close(); } catch (_) {}
    }
    K.speakerAnalysers.clear();
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
    for (const [peerId, m] of K.speakerAnalysers) {
      try { m.analyser.getByteFrequencyData(m.data); } catch (_) { continue; }
      const level = computeRms(m.data);
      if (level > K.SPEAKER_THRESHOLD && level > bestLevel) { best = peerId; bestLevel = level; }
    }
    setActiveSpeaker(best);
  }

  Object.assign(K, {
    callModal, callTitle, callStatus, callMembers, callTimerEl, callAudios, callVideos,
    callAcceptBtn, callRejectBtn, callMuteBtn, callCamBtn, callFlipBtn, callEndBtn,
    showCallModal, hideCallModal, renderCallMembers, setCallUI,
    startCallTimer, stopCallTimer, startRingTone, stopRingTone,
    createRemoteTile, getRemoteTile, setupSpeakerMeter, stopSpeakerMeters, setActiveSpeaker,
    tickActiveSpeaker
  });
  // 视频模块测试钩子（单测用；生产路径由音量检测驱动）
  Object.assign(app, { __videoTest: { computeRms, setActiveSpeaker, tickActiveSpeaker, createRemoteTile } });

  // 说话人检测循环（仅视频模式活跃；无 AudioContext 环境静默跳过）
  setInterval(tickActiveSpeaker, 250);
})();
