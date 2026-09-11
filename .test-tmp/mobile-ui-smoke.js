// DOM 桩冒烟测试：移动端布局
// 模拟手机宽度（innerWidth=400）验证：
// - applyMobileLayout 显示 ☰ 按钮 + 底部房间栏
// - 点 ☰ 打开抽屉（sidebar.open + backdrop 显示）
// - 底部房间栏渲染公共房 + 群聊房
// - 点底部房间项 → switchRoom → 抽屉自动收起
// - 点 backdrop 关闭抽屉
'use strict';
const path = require('path');

let failures = 0;
function assert(cond, name) {
  if (cond) console.log('  ✅', name);
  else { failures++; console.log('  ❌', name); }
}

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
      contains(c) { return this._s.has(c); },
      toggle(c, force) {
        if (force === undefined) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; }
        if (force) this._s.add(c); else this._s.delete(c);
        return !!force;
      }
    },
    addEventListener(evt, fn) {
      (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn);
    },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector(sel) {
      // 移动底部栏：按 data-room 在 children 中匹配（真实 DOM 能查到对应元素）
      const m = /\.mobile-room-item\[data-room="([^"]+)"\]/.exec(sel || '');
      if (m) {
        const want = m[1];
        return (this.children || []).find((c) => c.dataset && c.dataset.room === want) || null;
      }
      // 未读角标查询：桩内默认无匹配（触发创建分支）
      if (sel.includes('[data-role="unread"]')) return null;
      this._qs = this._qs || {};
      if (!this._qs[sel]) this._qs[sel] = makeEl(sel.startsWith('.') ? 'span' : 'div');
      return this._qs[sel];
    },
    querySelectorAll(sel) {
      if (sel === '.room-item') {
        const list = byId['roomList'];
        return list ? list.children.slice() : [];
      }
      if (sel === '.mobile-room-item') {
        const list = byId['mobileRoomList'];
        return list ? list.children.slice() : [];
      }
      return [];
    },
    focus() {},
    set innerHTML(v) { this._html = v; this.children.length = 0; },
    get innerHTML() { return this._html || ''; },
    set className(v) {
      this._className = v || '';
      this.classList._s = new Set(String(v || '').split(/\s+/).filter(Boolean));
    },
    get className() { return this._className || ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set value(v) { this._value = v; },
    get value() { return this._value === undefined ? '' : this._value; },
    set hidden(v) { this._hidden = v; },
    get hidden() { return this._hidden === true; },
    set disabled(v) { this._disabled = v; },
    get disabled() { return this._disabled === true; }
  };
  return el;
}

const ctxStub = { beginPath() {}, arc() {}, fill() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {} };
const byId = {};
const callAudiosStub = (() => { const el = makeEl('div'); el._audios = []; el.appendChild = (c) => { el._audios.push(c); return c; }; el.querySelector = () => null; el.querySelectorAll = () => []; return el; })();

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
    if (sel === '.sidebar') return byId['__sidebar'] || (byId['__sidebar'] = makeEl('aside'));
    if (sel === '.room-titlebar .rt-name') return byId['roomTitleName'] || (byId['roomTitleName'] = makeEl('span'));
    return makeEl('div');
  },
  querySelectorAll(sel) {
    if (sel === '.room-item') {
      const list = byId['roomList'];
      return list ? list.children.slice() : [];
    }
    if (sel === '.mobile-room-item') {
      const list = byId['mobileRoomList'];
      return list ? list.children.slice() : [];
    }
    return [];
  },
  createElement(tag) {
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ctxStub, toDataURL: () => 'data:image/png;base64,AAAA' };
    return makeEl(tag);
  },
  addEventListener() {}
};

const windowStub = {
  innerWidth: 400, // 模拟手机
  addEventListener() {},
  focus() {},
  // 模拟 matchMedia：与 innerWidth 同步（设备模拟切换只触发 matchMedia change，不触发 resize）
  matchMedia(query) {
    if (!this._mq) {
      const listeners = [];
      this._mq = {
        matches: () => windowStub.innerWidth <= 720,
        media: query,
        addEventListener(evt, fn) { if (evt === 'change') listeners.push(fn); },
        removeEventListener(evt, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
        _listeners: listeners,
        _fireChange() { listeners.forEach((fn) => fn({ matches: windowStub.innerWidth <= 720 })); }
      };
    }
    return this._mq;
  }
};

const socketHandlers = {};
const ackCalls = [];
const socketStub = {
  on(evt, cb) { socketHandlers[evt] = cb; },
  emit(evt, data, cb) {
    if (typeof data === 'function') { cb = data; data = undefined; }
    if (typeof cb === 'function') ackCalls.push({ evt, data, cb });
  }
};

class FakePC { constructor() {} addTrack() {} createOffer() { return Promise.resolve({ type: 'offer', sdp: 'o' }); } createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'a' }); } setLocalDescription() { return Promise.resolve(); } setRemoteDescription() { return Promise.resolve(); } addIceCandidate() { return Promise.resolve(); } close() {} }
const mediaStream = { getTracks() { return []; }, getAudioTracks() { return []; } };

const lsStore = { 'localsend-client-id': 'c-mobile-user' };
global.localStorage = { getItem: (k) => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = String(v); }, removeItem: (k) => { delete lsStore[k]; } };
global.window = windowStub;
global.document = documentStub;
global.CSS = { escape: (s) => String(s) };
global.io = () => socketStub;
global.RTCPeerConnection = FakePC;
global.confirm = () => true;
Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => Promise.resolve(mediaStream) } } });

// 预置真实 HTML 的初始 DOM 状态：drawerBackdrop 带 hidden、sidebar 存在于 DOM
byId['__sidebar'] = makeEl('aside');
byId['drawerBackdrop'] = makeEl('div');
byId['drawerBackdrop'].hidden = true;

require(path.join(__dirname, '..', 'public', 'client.js'));
require(path.join(__dirname, '..', 'public', 'share.js'));

const clickHandler = (el, evt, ev) => (el._listeners && el._listeners[evt] || []).forEach((f) => f(ev || {}));

console.log('--- 移动端初始布局 ---');
const sidebarToggle = byId['sidebarToggle'];
const mobileRoomBar = byId['mobileRoomBar'];
const drawerBackdrop = byId['drawerBackdrop'];
const sidebar = byId['__sidebar'];
assert(sidebarToggle.hidden === false, '☰ 按钮在移动端显示');
assert(mobileRoomBar.hidden === false, '底部房间栏在移动端显示');
assert(drawerBackdrop.hidden === true, '遮罩初始隐藏');
assert(!sidebar.classList.contains('open'), '抽屉初始关闭');

console.log('--- welcome + 群聊房恢复 → 底部栏渲染 ---');
socketHandlers.welcome({ id: 'srv-me', nickname: '我', online: 3, history: [], rooms: [
  { id: 'g1', name: '项目组', members: [{ clientId: 'cA', nickname: '我' }, { clientId: 'cB', nickname: '张三' }], createdAt: 1 },
  { id: 'g2', name: '闲聊', members: [{ clientId: 'cA', nickname: '我' }, { clientId: 'cC', nickname: '李四' }], createdAt: 2 }
] });
const mobileRoomList = byId['mobileRoomList'];
const roomItems = mobileRoomList.children;
assert(roomItems.length === 3, '底部栏有 3 项（公共房+g1+g2）');
assert((roomItems[0]._html || '').includes('公共房'), '第一项是公共房');
assert((roomItems[1]._html || '').includes('项目组'), '第二项是 g1');
assert(roomItems[0].classList.contains('active'), '公共房默认 active');

console.log('--- 点 ☰ 打开抽屉 ---');
clickHandler(sidebarToggle, 'click');
assert(sidebar.classList.contains('open'), '抽屉打开（sidebar.open）');
assert(drawerBackdrop.hidden === false, '遮罩显示');

console.log('--- 点底部 g1 项 → 切换 + 抽屉收起 ---');
clickHandler(roomItems[1], 'click');
const histCall = ackCalls.find((a) => a.evt === 'room_history' && a.data.room === 'g1');
assert(!!histCall, '点击底部项发起 room_history(g1)');
assert(roomItems[1].classList.contains('active'), 'g1 变 active');
assert(!sidebar.classList.contains('open'), '切房后抽屉自动收起');
assert(drawerBackdrop.hidden === true, '切房后遮罩隐藏');

console.log('--- 再开抽屉 → 点遮罩关闭 ---');
clickHandler(sidebarToggle, 'click');
assert(sidebar.classList.contains('open'), '抽屉再次打开');
clickHandler(drawerBackdrop, 'click');
assert(!sidebar.classList.contains('open'), '点遮罩关闭抽屉');
assert(drawerBackdrop.hidden === true, '遮罩隐藏');

console.log('--- 未读角标在底部栏显示 ---');
// 收到 g2 房间消息（当前在 g1）
socketHandlers.chat_message({ id: 'm1', type: 'text', room: 'g2', nickname: '李四', text: 'hi', timestamp: Date.now(), clientId: 'cC' });
const g2Item = roomItems.find((c) => (c._html || '').includes('闲聊'));
assert(!!g2Item, '找到 g2 底部项');
// updateRoomUnreadBadge 在移动端会 appendChild 一个 badge（桩内 children 记录）
const badge = g2Item.children.find((c) => c.className === 'mobile-room-unread');
assert(!!badge && String(badge._text) === '1', 'g2 底部项显示未读 1');

console.log('--- 关键场景：桌面宽 → 仅 matchMedia change 切回手机（模拟 Edge 设备模拟不触发 resize） ---');
// 先把窗口改成桌面宽并只触发 matchMedia change（不触发 resize），验证布局回桌面
windowStub.innerWidth = 1280;
const mq = windowStub.matchMedia('(max-width: 720px)');
assert(mq && mq._listeners.length > 0, 'matchMedia change 监听已注册');
mq._fireChange();
assert(byId['mobileRoomBar'].hidden === true, '切到桌面宽：底部栏隐藏');
assert(byId['sidebarToggle'].hidden === true, '切到桌面宽：☰ 隐藏');
// 只靠 matchMedia change 切回手机（不触发 resize）
windowStub.innerWidth = 390;
mq._fireChange();
assert(byId['mobileRoomBar'].hidden === false, '仅 matchMedia change：底部栏显示');
assert(byId['sidebarToggle'].hidden === false, '仅 matchMedia change：☰ 显示');

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
