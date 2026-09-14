// DOM 桩冒烟测试：拉起群聊弹窗
// 验证修复：成员列表多选后点「拉起群聊」→ 弹窗已选区显示这些成员；
// 弹窗内「在线成员」区可继续添加；移除 chip 后已选区与选择区联动。
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
      // 持久缓存：同一选择器返回同一实例（模拟真实 DOM 元素身份稳定）
      this._qs = this._qs || {};
      if (!this._qs[sel]) this._qs[sel] = makeEl(sel.startsWith('.') ? 'span' : 'div');
      return this._qs[sel];
    },
    querySelectorAll() { return []; },
    focus() {},
    scrollTo() {},
    play() { return Promise.resolve(); },
    set innerHTML(v) { this._html = v; this.children.length = 0; },
    get innerHTML() { return this._html || ''; },
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
    if (sel === '.room-titlebar .rt-name') return byId['roomTitleName'] || (byId['roomTitleName'] = makeEl('span'));
    return makeEl('div');
  },
  querySelectorAll(sel) {
    if (sel === '.room-item') {
      const list = byId['roomList'];
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

const windowStub = { addEventListener() {}, focus() {} };
const socketHandlers = {};
const ackCalls = [];
const socketStub = {
  on(evt, cb) {
    // 真实 socket 同事件可挂多个监听；链式合并保持 socketHandlers[evt](...) 调用形式
    const prev = socketHandlers[evt];
    socketHandlers[evt] = prev ? (...args) => { prev(...args); cb(...args); } : cb;
  },
  emit(evt, data, cb) {
    if (typeof data === 'function') { cb = data; data = undefined; }
    if (typeof cb === 'function') ackCalls.push({ evt, data, cb });
  }
};

class FakePC { constructor() { this.remoteDescription = null; this.localDescription = { type: 'offer', sdp: 'o' }; } addTrack() {} createOffer() { return Promise.resolve({ type: 'offer', sdp: 'o' }); } createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'a' }); } setLocalDescription() { return Promise.resolve(); } setRemoteDescription() { return Promise.resolve(); } addIceCandidate() { return Promise.resolve(); } close() {} }

const mediaStream = { _muted: false, getTracks() { return this.getAudioTracks(); }, getAudioTracks() { return [{ enabled: !this._muted, stop() {}, set enabled(v) { this._muted = !v; } }]; } };

const lsStore = { 'localsend-client-id': 'c-test-user' };
global.localStorage = { getItem: (k) => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = String(v); }, removeItem: (k) => { delete lsStore[k]; } };
global.window = windowStub;
global.document = documentStub;
global.CSS = { escape: (s) => String(s) };
global.io = () => socketStub;
global.RTCPeerConnection = FakePC;
global.confirm = () => true;
Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => Promise.resolve(mediaStream) } } });

require(path.join(__dirname, '..', 'public', 'client.js'));
require(path.join(__dirname, '..', 'public', 'share.js'));

const clickHandler = (el, evt, ev) => (el._listeners && el._listeners[evt] || []).forEach((f) => f(ev || {}));

console.log('--- 准备：模拟在线成员列表 ---');
// 先 welcome 设置 myId（myId 用于过滤"我"自己）
socketHandlers.welcome({ id: 'srv-me', nickname: '我', online: 4, history: [], rooms: [] });
// 模拟 members_update：我 + 张三 + 李四 + 王五
socketHandlers.members_update([
  { id: 'srv-me', nickname: '我' },
  { id: 'srv-zhang', nickname: '张三' },
  { id: 'srv-li', nickname: '李四' },
  { id: 'srv-wang', nickname: '王五' }
]);

console.log('--- 成员列表渲染后 ---');
const memberList = byId['memberList'];
assert(memberList.children.length >= 3, '成员列表渲染了其他成员');

console.log('--- 模拟点击多选（张三 + 李四）---');
// 成员 li 通过 appendChild(nameSpan) 渲染，文本在 children 里
const liText = (li) => (li.children || []).map((c) => c._text || '').join('') + (li._text || '') + (li.title || '');
const zhangLi = memberList.children.find((c) => liText(c).includes('张三'));
const liLi = memberList.children.find((c) => liText(c).includes('李四'));
assert(!!zhangLi, '找到张三条目');
assert(!!liLi, '找到李四条目');
// li 上的点击监听是绑定在 li 上的（li.addEventListener('click', ...)）
const fireLi = (li) => { (li._listeners && li._listeners.click || []).forEach((f) => f({ target: { closest: () => null }, stopPropagation() {} })); };
fireLi(zhangLi);
fireLi(liLi);

console.log('--- 点「拉起群聊」→ 弹窗应显示已选成员 ---');
const roomCreateBtn = byId['roomCreateBtn'];
assert(!!roomCreateBtn, '拉起群聊按钮存在');
clickHandler(roomCreateBtn, 'click');
const groupSelList = byId['groupSelList'];
const groupPickList = byId['groupPickList'];
const selHtml = groupSelList.children.map((c) => c._html || c._text || '').join('');
assert(selHtml.includes('张三'), '弹窗已选区包含张三');
assert(selHtml.includes('李四'), '弹窗已选区包含李四');
assert(String(byId['groupSelCount'].textContent) === '2', '已选计数 = 2');
assert(byId['groupConfirm'].disabled === false, '创建按钮可用');

console.log('--- 弹窗内在线成员区：王五可添加 ---');
const pickHtml = groupPickList.children.map((c) => c._text || '').join('');
assert(pickHtml.includes('王五'), '在线成员区显示王五');
assert(!pickHtml.includes('张三'), '已选的张三不在可添加区');
assert(!pickHtml.includes('李四'), '已选的李四不在可添加区');
assert(!pickHtml.includes('我'), '自己不显示在可添加区');

console.log('--- 点击王五添加到已选 ---');
const wangChip = groupPickList.children.find((c) => c._text === '王五');
assert(!!wangChip, '王五 chip 存在');
clickHandler(wangChip, 'click');
const selHtml2 = groupSelList.children.map((c) => c._html || c._text || '').join('');
assert(selHtml2.includes('王五'), '王五被添加到已选');
assert(String(byId['groupSelCount'].textContent) === '3', '已选计数 = 3');

console.log('--- 移除李四（✕）---');
const liChip = groupSelList.children.find((c) => (c._html || '').includes('李四'));
assert(!!liChip, '李四 chip 存在');
const removeBtn = liChip.querySelector('.chip-remove');
assert(!!removeBtn, '移除按钮存在');
clickHandler(removeBtn, 'click');
const selHtml3 = groupSelList.children.map((c) => c._html || c._text || '').join('');
assert(!selHtml3.includes('李四'), '李四被移除');
assert(String(byId['groupSelCount'].textContent) === '2', '已选计数 = 2');
const pickHtml2 = groupPickList.children.map((c) => c._text || '').join('');
assert(pickHtml2.includes('李四'), '李四回到可添加区');

console.log('--- 点「创建群聊」→ 发送 targetIds ---');
clickHandler(byId['groupConfirm'], 'click');
const createCall = ackCalls.find((a) => a.evt === 'group_create');
assert(!!createCall, '发出 group_create');
assert(createCall.data.targetIds.length === 2, 'targetIds 含 2 人（张三+王五）');
assert(!createCall.data.targetIds.includes('srv-li'), '已移除的李四不在 targetIds');

console.log('--- 创建成功 → 模拟收到 group_created ---');
// 预置静态公共房项（真实 DOM 由 index.html 提供；桩里复用 byId['roomMain'] 模拟同源元素）
const roomList = byId['roomList'];
const roomMainStub = byId['roomMain'];
roomMainStub.dataset.room = 'main';
roomMainStub.className = 'room-item';
roomList.appendChild(roomMainStub);
// 公共房一次性点击绑定在模块加载时已执行（roomMain 桩元素），此处确认存在
assert(roomMainStub._roomClickBound === true, '公共房项已绑定点击（模块加载时）');
assert(roomMainStub._listeners && roomMainStub._listeners.click && roomMainStub._listeners.click.length > 0, '公共房项点击监听存在');
// 服务端会回 group_created（带 room），触发 myRooms 更新 + renderRoomList
socketHandlers.group_created({ room: { id: 'gtest1', name: '测试群', members: [{ clientId: 'cA', nickname: '我' }, { clientId: 'cB', nickname: '张三' }] } });
const roomItems = roomList.children;
const groupItem = roomItems.find((c) => (c.dataset && c.dataset.room === 'gtest1'));
assert(!!groupItem, '群聊项渲染在房间列表');
assert(roomItems.some((c) => (c.dataset && c.dataset.room === 'main')), '公共房项仍在列表首位');

console.log('--- 点击群聊项 → 切换 ---');
clickHandler(groupItem, 'click', { target: { closest: () => null } });
// switchRoom 发 room_history
const histCall = ackCalls.find((a) => a.evt === 'room_history' && a.data.room === 'gtest1');
assert(!!histCall, '点击群聊项发起 room_history(gtest1)');
// 回包加载历史
histCall.cb({ ok: true, room: 'gtest1', history: [{ id: 'm1', type: 'text', nickname: '张三', text: '群聊消息', timestamp: 1700000000000, room: 'gtest1', clientId: 'cB' }] });
const chatArea2 = byId['chatArea'];
assert((chatArea2.children.map((c) => c._html || c._text || '').join('')).includes('群聊消息'), '群聊历史渲染');

console.log('--- 点击公共房 → 切换回 main ---');
const mainItem = roomItems.find((c) => (c.dataset && c.dataset.room === 'main'));
assert(!!mainItem, '找到公共房项');
assert(mainItem._listeners && mainItem._listeners.click && mainItem._listeners.click.length > 0, '公共房项绑定了点击事件');
const mainCallsBefore = ackCalls.filter((a) => a.evt === 'room_history' && a.data.room === 'main').length;
clickHandler(mainItem, 'click', { target: { closest: () => null } });
const mainCallsAfter = ackCalls.filter((a) => a.evt === 'room_history' && a.data.room === 'main').length;
assert(mainCallsAfter > mainCallsBefore, '点击公共房发起 room_history(main)（切换生效）');

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
