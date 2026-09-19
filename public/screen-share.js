/* 屏幕共享：1 名共享者 → 多名观看者（WebRTC Mesh，P2P 直连）
 * 共享者 getDisplayMedia 采集屏幕，为每位观看者各建一条 RTCPeerConnection 推流；
 * 观看者各持一条连接接流播放；信令走服务器的 ss_* 事件。 */
(function () {
  'use strict';

  if (!window.chatApp) return; // 依赖 client.js / share.js 先加载
  const socket = window.chatApp.socket;

  // ---------- DOM ----------
  const tabScreen = document.getElementById('tabScreen');
  const screenView = document.getElementById('screenView');
  const ssStatus = document.getElementById('ssStatus');
  const ssStartBtn = document.getElementById('ssStartBtn');
  const ssStopBtn = document.getElementById('ssStopBtn');
  const ssWatchBtn = document.getElementById('ssWatchBtn');
  const ssUnwatchBtn = document.getElementById('ssUnwatchBtn');
  const ssVideo = document.getElementById('ssVideo');
  const ssEmpty = document.getElementById('ssEmpty');
  const ssViewersBox = document.getElementById('ssViewersBox');
  const ssViewerCount = document.getElementById('ssViewerCount');
  const ssViewerChips = document.getElementById('ssViewerChips');
  const ssHint = document.getElementById('ssHint');

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // 优先用服务端下发的 TURN/STUN 列表（配置中心 turnServers；call-bus 在 welcome 时写入），否则退回默认 STUN
  function pcConfig() {
    const shared = window.chatApp && window.chatApp._call && window.chatApp._call.RTC_CONFIG;
    return shared || RTC_CONFIG;
  }

  // ---------- 状态 ----------
  let sharing = false;                 // 我是共享者
  let watching = false;                // 我是观看者
  let presenter = null;                // 当前共享者 {id, name}（他人共享时）
  let localStream = null;              // 共享者的采集流
  const presenterPCs = new Map();      // 共享者侧：viewerId -> RTCPeerConnection
  const viewerNames = new Map();       // 共享者侧：viewerId -> 昵称
  let viewerPC = null;                 // 观看者侧连接
  let remotePresenterId = null;        // 观看者侧的共享者 id

  window.chatApp.registerTab('screen', tabScreen, [screenView]);

  function setHint(text, cls) {
    ssHint.textContent = text || '';
    ssHint.className = 'upload-hint' + (text ? ' show' : '') + (cls ? ' ' + cls : '');
  }

  // ---------- UI 渲染 ----------
  function render() {
    ssStartBtn.hidden = sharing || watching;
    ssStopBtn.hidden = !sharing;
    ssWatchBtn.hidden = sharing || watching || !presenter;
    ssUnwatchBtn.hidden = !watching;
    ssViewersBox.hidden = !sharing;
    ssVideo.hidden = !sharing && !watching;
    ssEmpty.hidden = sharing || watching || !!presenter;

    if (sharing) {
      ssStatus.innerHTML = `你正在共享屏幕 · <strong>${presenterPCs.size}</strong> 人观看`;
    } else if (watching && remotePresenterId) {
      ssStatus.textContent = `正在观看 ${presenter ? presenter.name : ''} 的屏幕共享`;
    } else if (presenter) {
      ssStatus.textContent = `${presenter.name} 正在共享屏幕`;
    } else {
      ssStatus.textContent = '当前没有人共享屏幕';
    }
    // 共享者看自己的预览（静音防回声）；观看者看远端流（带声音控制）
    ssVideo.muted = sharing;
    ssVideo.controls = watching;
    renderViewers();
  }

  function renderViewers() {
    ssViewerCount.textContent = viewerNames.size;
    ssViewerChips.innerHTML = '';
    for (const name of viewerNames.values()) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = name;
      ssViewerChips.appendChild(chip);
    }
  }

  // ---------- ICE 候选暂存（远端描述未设置前到达的候选先入队） ----------
  function safeAddIce(pc, candidate) {
    if (!pc || !candidate) return;
    if (pc.remoteDescription) {
      pc.addIceCandidate(candidate).catch(() => {});
    } else {
      (pc.__pendingIce = pc.__pendingIce || []).push(candidate);
    }
  }

  async function flushIce(pc) {
    if (!pc.__pendingIce) return;
    for (const c of pc.__pendingIce.splice(0)) {
      try { await pc.addIceCandidate(c); } catch (_) { /* ignore */ }
    }
  }

  // ---------- 共享者 ----------
  async function startShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return setHint('当前浏览器不支持屏幕共享，请使用 Chrome / Edge', 'error');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
        setHint('无法采集屏幕：' + (e.message || e), 'error');
      }
      return; // 用户取消则不动
    }
    socket.emit('ss_start', (res) => {
      if (!res || !res.ok) {
        stream.getTracks().forEach((t) => t.stop());
        setHint((res && res.error) || '开启共享失败', 'error');
        return;
      }
      localStream = stream;
      sharing = true;
      // 浏览器自带"停止共享"按钮触发时同步收尾
      const vt = stream.getVideoTracks()[0];
      if (vt) vt.addEventListener('ended', stopShare);
      ssVideo.srcObject = stream;
      ssVideo.play().catch(() => {});
      setHint('');
      render();
    });
  }

  function stopShare() {
    if (!sharing) return;
    sharing = false;
    for (const pc of presenterPCs.values()) pc.close();
    presenterPCs.clear();
    viewerNames.clear();
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    ssVideo.srcObject = null;
    socket.emit('ss_stop');
    render();
  }

  // 新观看者加入 → 为其建一条 P2P 连接并推流
  socket.on('ss_viewer_joined', async (data) => {
    if (!sharing || !localStream || !data) return;
    const viewerId = data.viewerId;
    viewerNames.set(viewerId, data.viewerName || '观众');
    renderViewers();
    const pc = new RTCPeerConnection(pcConfig());
    presenterPCs.set(viewerId, pc);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ss_ice', { toId: viewerId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') dropViewer(viewerId);
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('ss_offer', { toId: viewerId, sdp: pc.localDescription });
      render();
    } catch (e) {
      dropViewer(viewerId);
    }
  });

  socket.on('ss_viewer_left', (data) => {
    if (data) dropViewer(data.viewerId);
  });

  function dropViewer(viewerId) {
    const pc = presenterPCs.get(viewerId);
    if (pc) {
      pc.close();
      presenterPCs.delete(viewerId);
    }
    viewerNames.delete(viewerId);
    if (sharing) render();
  }

  socket.on('ss_answer', async (data) => {
    const pc = data && presenterPCs.get(data.fromId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(data.sdp);
      await flushIce(pc);
    } catch (_) { /* ignore */ }
  });

  // ---------- 观看者 ----------
  function startWatch() {
    socket.emit('ss_watch', (res) => {
      if (!res || !res.ok) {
        return setHint((res && res.error) || '无法观看', 'error');
      }
      watching = true;
      remotePresenterId = res.presenterId;
      presenter = { id: res.presenterId, name: res.presenterName };
      setHint('');
      render();
      // 等待共享者的 ss_offer
    });
  }

  function stopWatch() {
    if (!watching) return;
    watching = false;
    remotePresenterId = null;
    if (viewerPC) {
      viewerPC.close();
      viewerPC = null;
    }
    ssVideo.srcObject = null;
    socket.emit('ss_unwatch');
    render();
  }

  socket.on('ss_offer', async (data) => {
    if (!watching || !data || data.fromId !== remotePresenterId) return;
    if (viewerPC) viewerPC.close();
    viewerPC = new RTCPeerConnection(pcConfig());
    viewerPC.onicecandidate = (e) => {
      if (e.candidate) socket.emit('ss_ice', { toId: data.fromId, candidate: e.candidate });
    };
    viewerPC.ontrack = (e) => {
      ssVideo.srcObject = e.streams[0];
      ssVideo.play().catch(() => {});
    };
    viewerPC.onconnectionstatechange = () => {
      if (viewerPC && viewerPC.connectionState === 'failed') {
        setHint('连接中断，可尝试重新观看', 'error');
      }
    };
    try {
      await viewerPC.setRemoteDescription(data.sdp);
      await flushIce(viewerPC);
      const answer = await viewerPC.createAnswer();
      await viewerPC.setLocalDescription(answer);
      socket.emit('ss_answer', { toId: data.fromId, sdp: viewerPC.localDescription });
    } catch (_) { /* ignore */ }
  });

  // ICE 双向共用（共享者按 fromId 找观看者连接；观看者只有一条连接）
  socket.on('ss_ice', (data) => {
    if (!data) return;
    if (sharing) {
      safeAddIce(presenterPCs.get(data.fromId), data.candidate);
    } else if (watching && data.fromId === remotePresenterId) {
      safeAddIce(viewerPC, data.candidate);
    }
  });

  // ---------- 全局状态同步 ----------
  socket.on('ss_started', (data) => {
    if (!data || sharing) return;
    presenter = { id: data.presenterId, name: data.presenterName };
    render();
  });

  socket.on('ss_ended', () => {
    presenter = null;
    if (watching) {
      watching = false;
      remotePresenterId = null;
      if (viewerPC) {
        viewerPC.close();
        viewerPC = null;
      }
      ssVideo.srcObject = null;
      setHint('共享已结束');
    }
    render();
  });

  socket.on('ss_state', (s) => {
    if (sharing) return;
    presenter = s && s.active ? { id: s.presenterId, name: s.presenterName } : null;
    render();
  });

  // 断线重连：本地流与连接全部失效（服务器端已做对应清理）
  socket.on('connect', () => {
    for (const pc of presenterPCs.values()) pc.close();
    presenterPCs.clear();
    viewerNames.clear();
    if (viewerPC) {
      viewerPC.close();
      viewerPC = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (sharing || watching) {
      setHint('连接已断开重连，请重新操作', 'error');
    }
    sharing = false;
    watching = false;
    remotePresenterId = null;
    ssVideo.srcObject = null;
    render();
  });

  // ---------- 按钮 ----------
  ssStartBtn.addEventListener('click', startShare);
  ssStopBtn.addEventListener('click', stopShare);
  ssWatchBtn.addEventListener('click', startWatch);
  ssUnwatchBtn.addEventListener('click', stopWatch);

  render();
})();
