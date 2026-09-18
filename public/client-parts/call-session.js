/* call 会话与信令片：主叫/被叫动作（发起·接听·拒绝·静音·挂断）与全部 rtc_ 与 call_ 前缀的
 * socket 监听、按钮绑定、对外导出。跨片经内部总线 K（app._call）调媒体/UI 能力。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const K = app._call;
  const socket = app.socket;
  const state = app.state;

  // ---------- 对外动作 ----------
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
    K.setCallUI('ringing');
    K.startRingTone();
    try {
      state.localStream = await K.getMedia(state.videoMode);
    } catch (_) {
      K.failCall('无法获取麦克风权限，请检查浏览器设置');
      return;
    }
    // 请求了视频但被降级成纯音频（无摄像头/被拒）→ 以实际轨道为准
    if (state.videoMode && !state.localStream.getVideoTracks().length) state.camOn = false;
    K.setupLocalPreview();
    socket.emit('call_user', { targets: list.map((t) => t.id), video: state.videoMode });
  }

  // 被叫：接听（接听后作为新成员向既有成员发 offer）
  async function acceptCall() {
    if (state.callState !== 'incoming') return;
    K.stopRingTone();
    try {
      state.localStream = await K.getMedia(state.videoMode);
    } catch (_) {
      socket.emit('call_reject', { roomId: state.roomId });
      K.failCall('无法获取麦克风权限，已拒绝通话');
      return;
    }
    if (state.videoMode && !state.localStream.getVideoTracks().length) state.camOn = false;
    K.setupLocalPreview();
    state.callState = 'active';
    socket.emit('call_accept', { roomId: state.roomId });
    K.startCallTimer();
  }

  // 被叫：拒绝
  function rejectCall() {
    if (state.callState !== 'incoming') return;
    socket.emit('call_reject', { roomId: state.roomId });
    K.stopRingTone();
    K.hideCallModal();
    state.callState = 'idle';
    state.roster = [];
    state.ringingTargets = [];
  }

  // 静音切换
  function toggleMute() {
    if (!state.localStream) return;
    state.muted = !state.muted;
    state.localStream.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
    K.callMuteBtn.textContent = state.muted ? '取消静音' : '静音';
  }

  // 挂断 / 取消（房间模型统一走 call_end）
  function endCall() {
    if (state.callState === 'idle') return;
    if (state.callState === 'incoming') { rejectCall(); return; }
    if (state.roomId) socket.emit('call_end', { roomId: state.roomId });
    K.cleanupCall();
  }

  // ---------- 信令监听 ----------
  socket.on('incoming_call', (data) => {
    if (state.callState !== 'idle') {
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
    K.setCallUI('incoming');
    K.startRingTone();
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
    K.setCallUI('ringing');
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
    state.roster = (data.members || []).filter((m) => m);
    const newMember = data.member;
    const iAmNew = newMember && newMember.id === state.myId;
    if (state.callState === 'ringing') {
      state.callState = 'active';
      K.stopRingTone();
      K.setCallUI('active');
      K.startCallTimer();
    } else {
      K.setCallUI(state.callState);
    }
    if (iAmNew && state.localStream) {
      // 新成员：主动向每个既有成员发 offer（避免 glare）
      for (const m of state.roster) {
        if (m.id === state.myId) continue;
        try {
          const p = K.ensurePeer(m.id);
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
  });

  // 有人离开房间
  socket.on('room_member_left', (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const leaverId = data.memberId;
    K.removePeer(leaverId);
    state.roster = state.roster.filter((m) => m.id !== leaverId);
    if (state.roster.length <= 1) {
      K.cleanupCall(data.reason === 'offline' ? '对方已离线，通话结束' : '通话已结束');
      return;
    }
    K.setCallUI('active');
    if (data.memberName) app.setHint(`${data.memberName} 离开了通话`, 'success');
  });

  socket.on('call_rejected', (data) => {
    if (state.callState === 'ringing') {
      app.setHint(`${(data && data.memberName) || '有人'} 拒绝了通话`, '');
      if (data && data.memberId) {
        state.ringingTargets = state.ringingTargets.filter((t) => t.id !== data.memberId);
        K.renderCallMembers();
      }
    }
  });

  socket.on('call_failed', (data) => {
    if (state.callState === 'ringing' || state.callState === 'incoming') {
      K.failCall((data && data.error) || '无法建立通话');
    }
  });

  socket.on('call_cancelled', () => {
    if (state.callState === 'incoming') {
      K.stopRingTone();
      K.hideCallModal();
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
      const p = K.ensurePeer(fromId);
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
      if (p._renegotiateQueued) { p._renegotiateQueued = false; K.maybeRenegotiate(p, data.fromId); }
    } catch (_) { /* 状态不符时忽略 */ }
  });

  socket.on('rtc_ice', async (data) => {
    if (state.callState === 'idle' || data.roomId !== state.roomId) return;
    const p = state.peers.get(data.fromId);
    if (!p) return;
    try { await p.addIceCandidate(data.candidate); } catch (_) { /* 候选可能已过期 */ }
  });

  // 按钮绑定（多选呼叫按钮 groupCallBtn/callSelectedBtn/callSelectionClearBtn 在 members.js 绑定）
  K.callAcceptBtn.addEventListener('click', acceptCall);
  K.callRejectBtn.addEventListener('click', rejectCall);
  K.callMuteBtn.addEventListener('click', toggleMute);
  K.callCamBtn.addEventListener('click', K.toggleCamera);
  K.callFlipBtn.addEventListener('click', K.flipCamera);
  K.callEndBtn.addEventListener('click', endCall);

  // 断线清理
  socket.on('disconnect', () => {
    if (state.callState !== 'idle') K.cleanupCall('连接断开，通话结束');
  });

  // 暴露给壳与其他分片（日历"一键拉会"等）
  Object.assign(app, {
    startCall,
    callTargets: (targetIds) => startCall((targetIds || []).map((id) => ({ id, nickname: '' }))),
    toggleCamera: K.toggleCamera,
    flipCamera: K.flipCamera
  });
})();
