// DOM 桩冒烟测试：加载 client.js，验证多方通话 UI 状态机（Mesh 房间模型）：
// 多选成员、群呼按钮、来电弹窗、接听(新成员发 offer)、中途加入、离开、忙线、挂断。
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
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, force) {
        const want = force === undefined ? !this._s.has(c) : !!force;
        if (want) this._s.add(c); else this._s.delete(c);
        return want;
      },
      contains(c) { return this._s.has(c); }
    },
    addEventListener(evt, fn) {
      (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn);
    },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    scrollTo() {},
    play() { return Promise.resolve(); },
    set innerHTML(v) { this._html = v; this.children.length = 0; },
    get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set value(v) { this._value = v; },
    get value() { return this._value; },
    set hidden(v) { this._hidden = v; },
    get hidden() { return this._hidden === true; },
    set srcObject(v) { this._srcObject = v; }
  };
  return el;
}

const ctxStub = {
  beginPath() {}, arc() {}, fill() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {},
  set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {}
};

const byId = {};
const documentHandlers = {};
// callAudios 需要支持 querySelector 找 audio[data-peer]
const callAudiosStub = (() => {
  const el = makeEl('div');
  el._audios = [];
  el.appendChild = (c) => { el._audios.push(c); el.children.push(c); return c; };
  el.querySelector = (sel) => {
    const m = /audio\[data-peer="([^"]+)"\]/.exec(sel || '');
    if (m) return el._audios.find((a) => a.dataset.peer === m[1]) || null;
    return null;
  };
  el.querySelectorAll = (sel) => (sel === 'audio' ? el._audios.slice() : []);
  return el;
})();

const documentStub = {
  title: '局域网聊天室',
  head: makeEl('head'),
  body: makeEl('body'),
  visibilityState: 'visible',
  hasFocus: () => false,
  getElementById(id) {
    if (id === 'callAudios') return callAudiosStub;
    return byId[id] || (byId[id] = makeEl('div'));
  },
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
  on(evt, cb) {
    // 真实 socket 同事件可挂多个监听；链式合并保持 socketHandlers[evt](...) 调用形式
    const prev = socketHandlers[evt];
    socketHandlers[evt] = prev ? (...args) => { prev(...args); cb(...args); } : cb;
  },
  emit(evt, data) { emitted.push({ evt, data }); }
};

// ---------- 桩 WebRTC ----------
class FakePC {
  constructor() {
    this.remoteDescription = null;
    this.localDescription = { type: 'offer', sdp: 'fake-local' };
    this.connectionState = 'new';
    FakePC.instances.push(this);
    FakePC.openCount++;
  }
  addTrack() {}
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'o' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'a' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription(sdp) { this.remoteDescription = sdp; return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  close() { this.connectionState = 'closed'; FakePC.openCount--; }
}
FakePC.instances = [];
FakePC.openCount = 0;

const mediaStream = {
  _muted: false,
  getTracks() { return this.getAudioTracks(); },
  getAudioTracks() { return [{ enabled: !this._muted, stop() {}, set enabled(v) { this._muted = !v; } }]; }
};

global.window = windowStub;
global.document = documentStub;
global.io = () => socketStub;
global.RTCPeerConnection = FakePC;
global.CSS = { escape: (s) => String(s).replace(/["\\\]]/g, '\\$&') };
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => Promise.resolve(mediaStream) } }
});

// ---------- 加载 client.js ----------
require(path.join(__dirname, '..', 'public', 'client.js'));

console.log('--- 加载与成员列表 ---');
assert(typeof socketHandlers.incoming_call === 'function', '已注册 incoming_call');
assert(typeof socketHandlers.room_member_joined === 'function', '已注册 room_member_joined');
assert(typeof socketHandlers.room_member_left === 'function', '已注册 room_member_left');
assert(typeof socketHandlers.rtc_offer === 'function', '已注册 rtc_offer');

// 模拟 welcome
socketHandlers.welcome({ id: 'me-1', nickname: '我', online: 3 });

const memberList = byId['memberList'];
const callModal = byId['callModal'];
const callMembers = byId['callMembers'];
const callStatus = byId['callStatus'];
const callTitle = byId['callTitle'];
const acceptBtn = byId['callAcceptBtn'];
const rejectBtn = byId['callRejectBtn'];
const muteBtn = byId['callMuteBtn'];
const endBtn = byId['callEndBtn'];
const callActionBar = byId['callActionBar'];
const callSelectedBtn = byId['callSelectedBtn'];
const groupCallBtn = byId['groupCallBtn'];

// members_update: 自己 + 张三 + 李四
socketHandlers.members_update([
  { id: 'me-1', nickname: '我' },
  { id: 'peer-9', nickname: '张三' },
  { id: 'peer-8', nickname: '李四' }
]);

const clickHandler = (el, evt) => (el._listeners && el._listeners[evt] || []).forEach((f) => f());

console.log('--- 多选群呼 ---');
// 点击张三的 li 选中
const zhangLi = memberList.children.find((li) => li.children.some((c) => c.textContent === '张三'));
clickHandler(zhangLi, 'click');
assert(callActionBar.hidden === false, '选中后操作条出现');
assert(callSelectedBtn.textContent === '发起通话 (1)', '按钮显示数量 1');
// 再选李四
const liLi = memberList.children.find((li) => li.children.some((c) => c.textContent === '李四'));
clickHandler(liLi, 'click');
assert(callSelectedBtn.textContent === '发起通话 (2)', '按钮显示数量 2');
// 发起（startCall 内先 await getMic，emit 稍后发生 → 延后断言）
clickHandler(callSelectedBtn, 'click');
setTimeout(() => {
  assert(emitted.some((e) => e.evt === 'call_user' && e.data.targets.length === 2 && e.data.targets.includes('peer-9') && e.data.targets.includes('peer-8')), '已发送 call_user 含两个目标');
  assert(callModal.hidden === false, '呼叫弹窗显示');
  assert(callTitle.textContent === '正在呼叫…', '标题为正在呼叫');
  assert(callMembers.children.length >= 2, 'chips 显示两个振铃目标');

  console.log('--- 主叫收振铃确认 ---');
  socketHandlers.call_ringing({
    roomId: 'room-1',
    targets: [{ id: 'peer-9', nickname: '张三' }, { id: 'peer-8', nickname: '李四' }],
    busy: [], offline: []
  });
  assert(callMembers.children.length >= 2, '振铃 chips 保留');

  console.log('--- 有人接听 → 通话开始 ---');
  socketHandlers.room_member_joined({
    roomId: 'room-1',
    member: { id: 'peer-9', nickname: '张三' },
    members: [{ id: 'me-1', nickname: '我' }, { id: 'peer-9', nickname: '张三' }]
  });
  setTimeout(() => {
    assert(callTitle.textContent === '通话中', '接听后标题为通话中');
    assert(muteBtn.hidden === false, '静音按钮出现');
    assert(callMembers.children.length >= 2, 'chips 含自己和张三');
  assert(FakePC.openCount === 0, '主叫(非新成员)不发 offer, 等对方 offer');
  // 张三(新成员) 的 offer 到达 → 主叫应答
  socketHandlers.rtc_offer({ roomId: 'room-1', fromId: 'peer-9', sdp: { type: 'offer', sdp: 'o' } });
  setTimeout(() => {
    assert(FakePC.openCount === 1, '收到 offer 后创建 PC');
    assert(emitted.some((e) => e.evt === 'rtc_answer' && e.data.toId === 'peer-9' && e.data.roomId === 'room-1'), '已回 answer(带 roomId)');

    console.log('--- 中途加入：李四接听 ---');
    socketHandlers.room_member_joined({
      roomId: 'room-1',
      member: { id: 'peer-8', nickname: '李四' },
      members: [{ id: 'me-1', nickname: '我' }, { id: 'peer-9', nickname: '张三' }, { id: 'peer-8', nickname: '李四' }]
    });
    assert(callTitle.textContent === '通话中 (3 人)', '标题显示人数');
    assert(callMembers.children.length === 3, 'chips 含三人');
    // 李四(新成员)发 offer → 应答
    socketHandlers.rtc_offer({ roomId: 'room-1', fromId: 'peer-8', sdp: { type: 'offer', sdp: 'o2' } });
    setTimeout(() => {
      assert(FakePC.openCount === 2, '第二条 PC 建立');

      console.log('--- 静音 ---');
      clickHandler(muteBtn, 'click');
      assert(muteBtn.textContent === '取消静音', '静音文案变化');
      clickHandler(muteBtn, 'click');

      console.log('--- 有人离开(通话继续) ---');
      socketHandlers.room_member_left({ roomId: 'room-1', memberId: 'peer-8', memberName: '李四', reason: 'hangup' });
      assert(callModal.hidden === false, '弹窗还在');
      assert(callMembers.children.length === 2, 'chips 剩两人');
      assert(FakePC.openCount === 1, '李四的 PC 被关闭');

      console.log('--- 最后一人离开 → 通话结束 ---');
      socketHandlers.room_member_left({ roomId: 'room-1', memberId: 'peer-9', memberName: '张三', reason: 'hangup' });
      assert(callModal.hidden === true, '只剩自己 → 弹窗关闭');
      assert(callMembers.children.length === 0, 'chips 清空');

      console.log('--- 被叫侧：来电 → 接听 → 发 offer ---');
      // 重新制造来电（主叫 me 被 peer-9 呼叫）
      socketHandlers.incoming_call({
        roomId: 'room-2', fromId: 'peer-9', fromName: '张三',
        targets: [{ id: 'peer-9', nickname: '张三' }],
        roster: [{ id: 'peer-9', nickname: '张三' }]
      });
      assert(callModal.hidden === false, '来电弹窗显示');
      assert(callTitle.textContent === '来电', '标题为来电');
      assert(acceptBtn.hidden === false, '接听按钮可见');
      clickHandler(acceptBtn, 'click');
      setTimeout(() => {
        assert(emitted.some((e) => e.evt === 'call_accept' && e.data.roomId === 'room-2'), '已发送 call_accept');
        // 服务端广播 room_member_joined → 我是新成员 → 主动发 offer
        socketHandlers.room_member_joined({
          roomId: 'room-2',
          member: { id: 'me-1', nickname: '我' },
          members: [{ id: 'peer-9', nickname: '张三' }, { id: 'me-1', nickname: '我' }]
        });
        setTimeout(() => {
          assert(emitted.some((e) => e.evt === 'rtc_offer' && e.data.toId === 'peer-9' && e.data.roomId === 'room-2'), '新成员主动发 offer');
          assert(callTitle.textContent === '通话中', '接听后进入通话中');

          console.log('--- 忙线自动拒绝 ---');
          // 通话中收到新来电 → 自动拒绝
          socketHandlers.incoming_call({ roomId: 'room-3', fromId: 'peer-8', fromName: '李四', targets: [{ id: 'peer-8', nickname: '李四' }], roster: [{ id: 'peer-8', nickname: '李四' }] });
          assert(emitted.some((e) => e.evt === 'call_reject' && e.data.roomId === 'room-3'), '忙线自动拒绝');

          console.log('--- 挂断 ---');
          clickHandler(endBtn, 'click');
          assert(emitted.some((e) => e.evt === 'call_end' && e.data.roomId === 'room-2'), '已发送 call_end(roomId)');
          assert(callModal.hidden === true, '挂断后弹窗关闭');

          console.log('--- 群呼按钮 ---');
          // 清除通话状态后点群呼
          socketHandlers.call_cancelled();
          clickHandler(groupCallBtn, 'click');
          assert(emitted.some((e) => e.evt === 'call_user' && e.data.targets.length === 2 && e.data.targets.includes('peer-9') && e.data.targets.includes('peer-8')), '群呼包含所有在线成员');

          console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
          process.exit(failures === 0 ? 0 : 1);
        }, 60);
      }, 60);
    }, 60);
  }, 60);
}, 60);
}, 60);
