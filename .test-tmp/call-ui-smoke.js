// DOM 桩冒烟测试：加载 client.js，验证 WebRTC 通话 UI 状态机与成员列表呼叫按钮。
// 用最小 fake DOM + 桩 RTCPeerConnection/getUserMedia/socket 驱动，不触碰真实浏览器。
'use strict';
const path = require('path');

let failures = 0;
function assert(cond, name) {
  if (cond) console.log('  ✅', name);
  else { failures++; console.log('  ❌', name); }
}

// ---------- 最小元素桩 ----------
function makeEl(tag) {
  const el = {
    tagName: tag || 'div',
    children: [],
    style: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener(evt, fn) {
      (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn);
    },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeEl('div'); },
    focus() {},
    scrollTo() {},
    play() { return Promise.resolve(); },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set value(v) { this._value = v; },
    get value() { return this._value; },
    set hidden(v) { this._hidden = v; },
    get hidden() { return this._hidden === true; },
    set srcObject(v) { this._srcObject = v; },
    set src(v) { this._src = v; },
    set href(v) { this._href = v; }
  };
  return el;
}

const ctxStub = {
  beginPath() {}, arc() {}, fill() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {},
  set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {}
};

const byId = {};
const documentHandlers = {};
const documentStub = {
  title: '局域网聊天室',
  head: makeEl('head'),
  body: makeEl('body'),
  visibilityState: 'visible',
  hasFocus: () => false,
  getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
  querySelector(sel) {
    if (sel === 'link[rel="icon"]') return null;
    return makeEl('div');
  },
  createElement(tag) {
    if (tag === 'canvas') {
      return { width: 0, height: 0, getContext: () => ctxStub, toDataURL: () => 'data:image/png;base64,AAAA' };
    }
    return makeEl(tag);
  },
  addEventListener(evt, cb) { documentHandlers[evt] = cb; }
};

const windowHandlers = {};
const windowStub = {
  addEventListener(evt, cb) { windowHandlers[evt] = cb; },
  focus() {}
};

// ---------- 桩 socket：捕获所有事件与 emit ----------
const socketHandlers = {};
const emitted = [];
const socketStub = {
  on(evt, cb) { socketHandlers[evt] = cb; },
  emit(evt, data) { emitted.push({ evt, data }); }
};

// ---------- 桩 WebRTC ----------
class FakePC {
  constructor() {
    this.remoteDescription = null;
    this.localDescription = { type: 'offer', sdp: 'fake-local' };
    this.connectionState = 'new';
  }
  addTrack() {}
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'o' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'a' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription(sdp) { this.remoteDescription = sdp; return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  close() { this.connectionState = 'closed'; }
}
FakePC.instances = [];

const mediaStream = {
  _muted: false,
  getTracks() { return [this.getAudioTracks()[0]]; },
  getAudioTracks() { return [{ enabled: !this._muted, stop() {}, set enabled(v) { this._muted = !v; } }]; }
};

global.window = windowStub;
global.document = documentStub;
global.io = () => socketStub;
global.RTCPeerConnection = FakePC;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => Promise.resolve(mediaStream) } }
});

// ---------- 加载 client.js ----------
require(path.join(__dirname, '..', 'public', 'client.js'));

console.log('--- 加载与成员列表 ---');
assert(typeof socketHandlers.incoming_call === 'function', '已注册 incoming_call');
assert(typeof socketHandlers.rtc_offer === 'function', '已注册 rtc_offer');
assert(typeof socketHandlers.call_ended === 'function', '已注册 call_ended');

// 模拟 welcome 设置自己的 id
socketHandlers.welcome({ id: 'me-1', nickname: '我', online: 2 });

const memberList = byId['memberList'];
const callModal = byId['callModal'];
const callPeerName = byId['callPeerName'];
const callStatus = byId['callStatus'];
const callTitle = byId['callTitle'];
const acceptBtn = byId['callAcceptBtn'];
const rejectBtn = byId['callRejectBtn'];
const muteBtn = byId['callMuteBtn'];
const endBtn = byId['callEndBtn'];

// members_update: 自己 + 一个可呼叫的人
socketHandlers.members_update([
  { id: 'me-1', nickname: '我' },
  { id: 'peer-9', nickname: '张三' }
]);
const liWithCall = memberList.children.find((li) => li.children.some((c) => c.className === 'member-call'));
assert(!!liWithCall, '非自己成员渲染了呼叫按钮');
const selfLi = memberList.children.find((li) => li.children.some((c) => c.className === 'member-me'));
assert(!!selfLi, '自己成员不渲染呼叫按钮');

console.log('--- 来电（被叫侧） ---');
socketHandlers.incoming_call({ callId: 'call-1', fromId: 'peer-9', fromName: '张三' });
assert(callModal.hidden === false, '来电弹窗显示');
assert(callPeerName.textContent === '张三', '显示来电者昵称');
assert(callTitle.textContent === '来电', '标题为来电');
assert(acceptBtn.hidden === false, '接听按钮可见');
assert(rejectBtn.hidden === false, '拒绝按钮可见');

console.log('--- 接听流程 ---');
const clickHandler = (el, evt) => (el._listeners && el._listeners[evt] || []).forEach((f) => f());
clickHandler(acceptBtn, 'click');
// 异步等待 getUserMedia + answer
setTimeout(() => {
  try {
    assert(callModal.hidden === false, '接听后弹窗仍在');
    assert(callTitle.textContent === '通话中', '标题变为通话中');
    assert(acceptBtn.hidden === true, '接听按钮隐藏');
    assert(rejectBtn.hidden === true, '拒绝按钮隐藏');
    assert(muteBtn.hidden === false, '静音按钮出现');
    assert(emitted.some((e) => e.evt === 'call_accept'), '已发送 call_accept');

    console.log('--- 静音切换 ---');
    clickHandler(muteBtn, 'click');
    assert(muteBtn.textContent === '取消静音', '静音后按钮文案变化');
    clickHandler(muteBtn, 'click');
    assert(muteBtn.textContent === '静音', '再点恢复');

    console.log('--- 挂断 ---');
    clickHandler(endBtn, 'click');
    assert(emitted.some((e) => e.evt === 'call_end' && e.data.toId === 'peer-9'), '已发送 call_end');
    assert(callModal.hidden === true, '挂断后弹窗关闭');
    assert(acceptBtn.hidden === true && muteBtn.hidden === true && endBtn.hidden === true, '按钮全部复位');

    console.log('--- 主叫侧：呼叫流程 ---');
    // 重新渲染成员并点击呼叫按钮
    socketHandlers.members_update([
      { id: 'me-1', nickname: '我' },
      { id: 'peer-9', nickname: '张三' }
    ]);
    const callBtn = memberList.children[1].children.find((c) => c.className === 'member-call');
    clickHandler(callBtn, 'click');
    setTimeout(() => {
      try {
        assert(callModal.hidden === false, '呼叫弹窗显示');
        assert(callTitle.textContent === '正在呼叫…', '标题为正在呼叫');
        assert(emitted.some((e) => e.evt === 'call_user' && e.data.targetId === 'peer-9'), '已发送 call_user');
        assert(emitted.some((e) => e.evt === 'rtc_offer' && e.data.toId === 'peer-9'), '已发送 rtc_offer');

        // 主叫收到 call_accepted
        socketHandlers.call_accepted({ callId: 'call-2', toId: 'peer-9', toName: '张三' });
        assert(callTitle.textContent === '通话中', '接听后主叫进入通话中');

        console.log('--- 忙线（通话中来新来电 → 自动拒绝） ---');
        const rejectCountBefore = emitted.filter((e) => e.evt === 'call_reject').length;
        socketHandlers.incoming_call({ callId: 'call-3', fromId: 'peer-9', fromName: '张三' });
        assert(callTitle.textContent === '通话中', '忙线时通话弹窗不被新来电打断');
        assert(emitted.filter((e) => e.evt === 'call_reject').length === rejectCountBefore + 1, '忙线自动拒绝新来电');

        // 收到对方挂断
        socketHandlers.call_ended({ fromId: 'peer-9', reason: 'hangup' });
        assert(callModal.hidden === true, '对方挂断后弹窗关闭');

        // 挂断后回到空闲，新来电应正常弹窗
        socketHandlers.incoming_call({ callId: 'call-4', fromId: 'peer-9', fromName: '张三' });
        assert(callModal.hidden === false, '空闲时新来电正常弹窗');
        assert(callTitle.textContent === '来电', '空闲时新来电标题正确');

        console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
        process.exit(failures === 0 ? 0 : 1);
      } catch (e) {
        console.error('主叫侧断言异常:', e);
        process.exit(1);
      }
    }, 50);
  } catch (e) {
    console.error('接听侧断言异常:', e);
    process.exit(1);
  }
}, 50);
