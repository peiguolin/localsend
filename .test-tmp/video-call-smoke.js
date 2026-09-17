/* 视频通话（方案 B）客户端冒烟：加载 client.js，用桩 RTCPeerConnection/getUserMedia/DOM
 * 驱动完整链路：视频发起(带 video 标志) → 被叫接入 → 视频 tile 渲染 → 远端无摄像头占位 →
 * 说话人高亮 → 摄像头开关(轨道增删+重协商) → 远端同时重协商(glare rollback) → 每路隐藏 →
 * 无摄像头降级纯语音 → 被叫接听视频来电 → 挂断清理。不触碰真实浏览器。 */
'use strict';
const path = require('path');

let failures = 0;
function assert(cond, name, extra) {
  if (cond) console.log('  ✅', name);
  else { failures++; console.log('  ❌', name + (extra !== undefined ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 通用元素桩：支持 class / [data-x="y"] / tag 复合选择器 ----------
function matches(sel, el) {
  if (!sel) return false;
  const parts = String(sel).trim().split(/\s+/).filter(Boolean);
  return parts.every((p) => {
    const tag = /^[a-zA-Z]+/.exec(p);
    if (tag && el.tagName && el.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    const attr = /\[data-([a-z]+)="([^"]*)"\]/.exec(p);
    if (attr && !(el.dataset && el.dataset[attr[1]] === attr[2])) return false;
    const cls = p.split('.').filter((x) => x && !/^[a-zA-Z]+$/.test(x) || x.startsWith('.')).map((x) => x.replace(/^\./, ''));
    // 纯 tag 名里的类部分
    const allCls = p.split('.').slice(1).map((x) => x.replace(/\[.*$/, '').replace(/^\./, '')).filter(Boolean);
    if (allCls.length && !allCls.every((c) => el.classList.contains(c))) return false;
    return true;
  });
}

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], style: {}, dataset: {}, _parent: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, force) { const want = force === undefined ? !this._s.has(c) : !!force; if (want) this._s.add(c); else this._s.delete(c); return want; },
      contains(c) { return this._s.has(c); }
    },
    set className(v) { this._className = v; this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return this._className || ''; },
    addEventListener(evt, fn) { (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn); },
    appendChild(c) { c._parent = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c._parent = this; const i = ref ? this.children.indexOf(ref) : this.children.length; this.children.splice(i < 0 ? 0 : i, 0, c); },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } },
    querySelector(sel) { const walk = (els) => { for (const e of els) { if (matches(sel, e)) return e; const r = walk(e.children || []); if (r) return r; } return null; }; return walk(this.children); },
    querySelectorAll(sel) { const out = []; const walk = (els) => { for (const e of els) { if (matches(sel, e)) out.push(e); walk(e.children || []); } }; walk(this.children); return out; },
    getBoundingClientRect() { return { left: 100, top: 100, width: 100, height: 80 }; },
    offsetWidth: 100, offsetHeight: 80,
    focus() {}, scrollTo() {}, play() { return Promise.resolve(); },
    set innerHTML(v) { this._html = v; this.children.length = 0; }, get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text || ''; },
    set hidden(v) { this._hidden = v; }, get hidden() { return this._hidden === true; }
  };
  return el;
}

// ---------- 媒体流桩 ----------
function makeStream(opts) {
  const tracks = [];
  if (opts.audio !== false) tracks.push({ kind: 'audio', enabled: true, stop() { this._stopped = true; } });
  if (opts.video) tracks.push({ kind: 'video', enabled: true, stop() { this._stopped = true; } });
  return {
    tracks,
    getTracks() { return this.tracks; },
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); },
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); },
    addTrack(t) { this.tracks.push(t); },
    removeTrack(t) { const i = this.tracks.indexOf(t); if (i >= 0) this.tracks.splice(i, 1); }
  };
}

// getUserMedia 桩：首次取音频，第二次（视频模式）取视频；failVideo 模拟视频失败
const gUMCalls = [];
let failVideo = false;
const getUserMediaStub = (constraints) => {
  gUMCalls.push(constraints);
  if (constraints.video) {
    if (failVideo) return Promise.reject(new Error('NotAllowedError'));
    return Promise.resolve(makeStream({ audio: false, video: true }));
  }
  return Promise.resolve(makeStream({ audio: true }));
};

// ---------- 桩 RTCPeerConnection（含 signalingState 生命周期） ----------
class FakePC {
  constructor() {
    this.signalingState = 'stable';
    this.remoteDescription = null;
    this.localDescription = null;
    this.connectionState = 'new';
    this.onnegotiationneeded = null;
    this.ontrack = null;
    this._senders = [];
    this._removed = [];
    this._rolledBack = false;
    FakePC.instances.push(this);
    FakePC.openCount++;
  }
  addTrack(track, stream) { this._senders.push({ track }); }
  getSenders() { return this._senders; }
  removeTrack(sender) { this._removed.push(sender); this._senders = this._senders.filter((s) => s !== sender); }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'o-' + FakePC.offerSeq++ }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'a-' + FakePC.answerSeq++ }); }
  setLocalDescription(d) {
    if (d && d.type === 'offer') this.signalingState = 'have-local-offer';
    else if (d && d.type === 'answer') this.signalingState = 'stable';
    else if (d && d.type === 'rollback') { this._rolledBack = true; this.signalingState = 'stable'; }
    this.localDescription = d;
    return Promise.resolve();
  }
  setRemoteDescription(d) {
    if (d && d.type === 'offer') this.signalingState = 'have-remote-offer';
    else if (d && d.type === 'answer') this.signalingState = 'stable';
    this.remoteDescription = d;
    return Promise.resolve();
  }
  addIceCandidate() { return Promise.resolve(); }
  close() { this.connectionState = 'closed'; FakePC.openCount--; }
}
FakePC.instances = [];
FakePC.openCount = 0;
FakePC.offerSeq = 0;
FakePC.answerSeq = 0;

// ---------- DOM / window / socket 桩 ----------
const ctxStub = {
  beginPath() {}, arc() {}, fill() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {},
  set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {}
};
const byId = {};
const documentHandlers = {};
const documentStub = {
  title: '局域网聊天室', head: makeEl('head'), body: makeEl('body'),
  visibilityState: 'visible', hasFocus: () => false,
  getElementById(id) {
    if (id === 'callVideos') { if (!byId.callVideos) byId.callVideos = makeEl('div'); return byId.callVideos; }
    return byId[id] || (byId[id] = makeEl('div'));
  },
  querySelector(sel) { if (sel === 'link[rel="icon"]') return null; return makeEl('div'); },
  createElement(tag) {
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ctxStub, toDataURL: () => 'data:image/png;base64,AAAA' };
    return makeEl(tag);
  },
  addEventListener(evt, cb) { documentHandlers[evt] = cb; }
};
const windowStub = { addEventListener() {}, focus() {} };

const socketHandlers = {};
const emitted = [];
const socketStub = {
  on(evt, cb) { const prev = socketHandlers[evt]; socketHandlers[evt] = prev ? (...a) => { prev(...a); cb(...a); } : cb; },
  emit(evt, data) { emitted.push({ evt, data }); }
};

global.window = windowStub;
global.document = documentStub;
global.io = () => socketStub;
global.RTCPeerConnection = FakePC;
global.CSS = { escape: (s) => String(s).replace(/["\\\]]/g, '\\$&') };
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: getUserMediaStub } }
});

// ---------- 加载 client.js ----------
require(path.join(__dirname, '..', 'public', 'client.js'));
const app = window.chatApp;
const state = app.state;
const videoTest = app.__videoTest;

console.log('--- 加载与成员列表 ---');
assert(typeof socketHandlers.rtc_offer === 'function' && typeof app.startCall === 'function', '已注册呼叫相关');
socketHandlers.welcome({ id: 'me-1', nickname: '我', online: 3 });
socketHandlers.members_update([
  { id: 'me-1', nickname: '我' },
  { id: 'peer-9', nickname: '张三' },
  { id: 'peer-8', nickname: '李四' }
]);

const clickHandler = (el, evt, ev) => (el._listeners && el._listeners[evt] || []).forEach((f) => f(ev || { stopPropagation() {} }));
const memberList = byId['memberList'];
const callVideos = byId['callVideos'];
const callCamBtn = byId['callCamBtn'];
const callModal = byId['callModal'];
const endBtn = byId['callEndBtn'];

console.log('--- 成员行视频按钮 → 发起视频呼叫 ---');
const zhangLi = memberList.children.find((li) => li.children.some((c) => c.textContent === '张三'));
const camBtn = zhangLi.children.find((c) => c.className.includes('member-cam'));
assert(!!camBtn, '张三行有视频呼叫按钮');
clickHandler(camBtn, 'click');
setTimeout(() => {
  const cu = emitted.find((e) => e.evt === 'call_user');
  assert(!!cu && cu.data.video === true && cu.data.targets.length === 1 && cu.data.targets[0] === 'peer-9', 'call_user 带 video:true 且目标正确');
  assert(state.videoMode === true && state.camOn === true, 'videoMode/camOn 置位');
  assert(callModal.hidden === false, '呼叫弹窗显示');

  socketHandlers.call_ringing({ roomId: 'room-v', targets: [{ id: 'peer-9', nickname: '张三' }], busy: [], offline: [], video: true });

  console.log('--- 张三接听 → 视频模式通话 UI ---');
  socketHandlers.room_member_joined({
    roomId: 'room-v',
    member: { id: 'peer-9', nickname: '张三' },
    members: [{ id: 'me-1', nickname: '我' }, { id: 'peer-9', nickname: '张三' }]
  });
  setTimeout(() => {
    assert(byId['callTitle'].textContent === '视频通话中', '标题为视频通话中');
    assert(callVideos.hidden === false, '视频网格显示');
    assert(callCamBtn.hidden === false && callCamBtn.textContent === '关摄像头', '摄像头按钮可见且为关');
    assert(!!callVideos.querySelector('.call-video-tile.local'), '有本地预览 tile');
    assert(FakePC.openCount === 0, '主叫(非新成员)不发 offer');

    console.log('--- 收到 offer → 建远端 tile ---');
    socketHandlers.rtc_offer({ roomId: 'room-v', fromId: 'peer-9', sdp: { type: 'offer', sdp: 'o0' } });
    setTimeout(() => {
      const pc = FakePC.instances[0];
      assert(FakePC.openCount === 1, '创建 PC');
      assert(emitted.some((e) => e.evt === 'rtc_answer' && e.data.toId === 'peer-9'), '应答 offer');
      const tile = callVideos.querySelector('[data-peer="peer-9"]');
      assert(!!tile, '远端 tile 建立');
      assert(!!tile.querySelector('video'), 'tile 内有 <video>');
      assert(!!tile.querySelector('.call-video-name') && tile.querySelector('.call-video-name').textContent === '张三', 'tile 显示名字');

      console.log('--- ontrack：有视频 → 显示；无视频 → 占位 ---');
      pc.ontrack({ streams: [makeStream({ audio: true, video: true })] });
      assert(tile.classList.contains('no-video') === false, '有视频时不显示占位');
      assert(!!tile.querySelector('video').srcObject, '远端流挂到 video');
      pc.ontrack({ streams: [makeStream({ audio: true })] });
      assert(tile.classList.contains('no-video') === true, '无视频时显示未开摄像头占位');

      console.log('--- 说话人高亮 ---');
      videoTest.setActiveSpeaker('peer-9');
      assert(tile.classList.contains('speaking') === true, '说话人 tile 高亮');
      videoTest.setActiveSpeaker('');
      assert(tile.classList.contains('speaking') === false, '静音后取消高亮');
      assert(videoTest.computeRms([0, 0, 0]) === 0, 'computeRms 静音=0');
      assert(videoTest.computeRms([255, 255]) > 100, 'computeRms 大声>100');

      console.log('--- 关摄像头 → 移除轨道 + 重协商 ---');
      clickHandler(callCamBtn, 'click');
      setTimeout(() => {
        assert(state.camOn === false, 'camOn=false');
        assert(callCamBtn.textContent === '开摄像头', '按钮文案=开摄像头');
        assert(byId['callFlipBtn'].hidden === true, '摄像头关闭时切换按钮隐藏');
        assert(pc._removed.length === 1 && pc._removed[0].track.kind === 'video', '从 PC 移除视频轨道');
        assert(emitted.filter((e) => e.evt === 'rtc_offer').length === 1, '关闭后发出重协商 offer');
        assert(pc.signalingState === 'have-local-offer', '本端持有未完成 offer');

        console.log('--- 双方同时重协商（glare）→ rollback 采纳对方 ---');
        socketHandlers.rtc_offer({ roomId: 'room-v', fromId: 'peer-9', sdp: { type: 'offer', sdp: 'o-glare' } });
        setTimeout(() => {
          assert(pc._rolledBack === true, 'glare 时 rollback');
          assert(pc.signalingState === 'stable', '重协商完成后回到 stable');
          assert(emitted.filter((e) => e.evt === 'rtc_answer').length === 2, '又应答一次（重协商）');

          console.log('--- 开摄像头 → 加轨道 + 再重协商 ---');
          clickHandler(callCamBtn, 'click');
          setTimeout(() => {
            assert(state.camOn === true, 'camOn=true');
            assert(pc._senders.some((s) => s.track.kind === 'video'), '重新加入视频轨道');
            assert(emitted.filter((e) => e.evt === 'rtc_offer').length === 2, '重开后发出重协商 offer');
            assert(byId['callFlipBtn'].hidden === false, '摄像头开启时切换按钮可见');

            console.log('--- 摄像头前后切换（前置→后置→前置，含排队协商）---');
            // 此时摄像头刚重开，上一条重协商 offer 尚未被应答（have-local-offer）
            clickHandler(byId['callFlipBtn'], 'click');
            setTimeout(() => {
              const back = gUMCalls.filter((c) => c.video).pop();
              assert(!!back && back.video.facingMode === 'environment', '以后置 environment 重新采集');
              assert(state.camFacing === 'environment', 'camFacing=environment');
              assert(pc._removed.filter((r) => r.track.kind === 'video').length === 2, '旧视频轨道已从 PC 移除');
              assert(pc._senders.some((s) => s.track.kind === 'video'), '新视频轨道已挂载');
              assert(pc._renegotiateQueued === true, '有未应答 offer → 翻转协商入队');
              assert(emitted.filter((e) => e.evt === 'rtc_offer').length === 2, '排队期间不重复发 offer');
              // 对端应答之前的 offer → 排队的翻转协商自动补发
              socketHandlers.rtc_answer({ roomId: 'room-v', fromId: 'peer-9', sdp: { type: 'answer', sdp: 'a-on' } });
              setTimeout(() => {
                assert(pc.signalingState === 'have-local-offer', '应答后排队的翻转 offer 已补发');
                assert(emitted.filter((e) => e.evt === 'rtc_offer').length === 3, '排队的翻转协商补发 offer');
                socketHandlers.rtc_answer({ roomId: 'room-v', fromId: 'peer-9', sdp: { type: 'answer', sdp: 'a-flip' } });
                setTimeout(() => {
                  assert(pc.signalingState === 'stable', '切换重协商完成回到 stable');
                  clickHandler(byId['callFlipBtn'], 'click');
                  setTimeout(() => {
                    const front = gUMCalls.filter((c) => c.video).pop();
                    assert(!!front && front.video.facingMode === 'user', '切回前置 user');
                    assert(state.camFacing === 'user', 'camFacing=user');
                    assert(emitted.filter((e) => e.evt === 'rtc_offer').length === 4, '切回也发重协商 offer');

                    console.log('--- 每路隐藏（仅本地）---');
            const hideBtn = tile.querySelector('.call-video-mute');
            clickHandler(hideBtn, 'click');
            assert(tile.querySelector('video').hidden === true && tile.classList.contains('no-video') === true, '隐藏该路视频');
            clickHandler(hideBtn, 'click');
            assert(tile.querySelector('video').hidden === false, '恢复显示');

            console.log('--- 挂断清理 ---');
            clickHandler(endBtn, 'click');
            assert(emitted.some((e) => e.evt === 'call_end'), '发出 call_end');
            assert(callModal.hidden === true, '弹窗关闭');
            assert(state.videoMode === false && state.camOn === false, '视频状态复位');
            assert(callVideos.innerHTML === '', '网格清空');

            console.log('--- 无摄像头降级：请求视频但被拒 → 纯语音 ---');
            failVideo = true;
            clickHandler(camBtn, 'click');
            setTimeout(() => {
              const cu2 = emitted.filter((e) => e.evt === 'call_user').pop();
              assert(state.camOn === false, '视频被拒后 camOn=false');
              assert(cu2 && cu2.data.video === true, '仍按视频呼叫发起（对方可看到无摄像头）');
              assert(state.localStream && state.localStream.getVideoTracks().length === 0, '本地流为纯音频');
              failVideo = false;
              clickHandler(endBtn, 'click');

              console.log('--- 被叫侧：视频来电 → 接听 → 主动发 offer ---');
              socketHandlers.incoming_call({
                roomId: 'room-v2', fromId: 'peer-9', fromName: '张三',
                targets: [{ id: 'peer-9', nickname: '张三' }],
                roster: [{ id: 'peer-9', nickname: '张三' }], video: true
              });
              assert(state.videoMode === true, '被叫识别视频来电');
              assert(byId['callStatus'].textContent.includes('视频'), '来电文案含视频');
              clickHandler(byId['callAcceptBtn'], 'click');
              setTimeout(() => {
                assert(emitted.some((e) => e.evt === 'call_accept'), '发出 call_accept');
                assert(state.camOn === true && state.localStream.getVideoTracks().length === 1, '接听后开启摄像头');
                // 服务端广播成员加入 → 新成员主动发 offer
                socketHandlers.room_member_joined({
                  roomId: 'room-v2', member: { id: 'me-1', nickname: '我' },
                  members: [{ id: 'peer-9', nickname: '张三' }, { id: 'me-1', nickname: '我' }]
                });
                setTimeout(() => {
                  assert(emitted.some((e) => e.evt === 'rtc_offer' && e.data.toId === 'peer-9'), '被叫(新成员)主动发 offer');
                  assert(callVideos.querySelectorAll('.call-video-tile').length === 2, '网格含本地预览 + 远端 tile');
                  clickHandler(endBtn, 'click');

                  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
                  process.exit(failures === 0 ? 0 : 1);
                }, 40);
              }, 40);
            }, 40);
          }, 40);
        }, 40);
      }, 40);
    }, 40);
  }, 40);
}, 40);
}, 40);
}, 40);
}, 40);
}, 40);
