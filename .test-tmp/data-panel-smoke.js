// DOM 桩冒烟测试：数据面板（data-panel.js）加载 + 历史消息渲染（welcome.history）
// 验证：welcome 带历史时渲染历史消息、数据面板注册 tab、统计/搜索/清空 socket 交互。
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
      contains(c) { return this._s.has(c); }
    },
    addEventListener(evt, fn) {
      (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn);
    },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelector() { return makeEl('div'); },
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

const ctxStub = {
  beginPath() {}, arc() {}, fill() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {},
  set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {}
};

const byId = {};
const callAudiosStub = (() => {
  const el = makeEl('div');
  el._audios = [];
  el.appendChild = (c) => { el._audios.push(c); el.children.push(c); return c; };
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
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
    if (sel === '.inputbar') return makeEl('div');
    return makeEl('div');
  },
  createElement(tag) {
    if (tag === 'canvas') {
      return { width: 0, height: 0, getContext: () => ctxStub, toDataURL: () => 'data:image/png;base64,AAAA' };
    }
    return makeEl(tag);
  },
  addEventListener() {}
};

const windowStub = { addEventListener() {}, focus() {} };

const socketHandlers = {};
const emitted = [];
const ackCalls = [];
const socketStub = {
  on(evt, cb) { socketHandlers[evt] = cb; },
  emit(evt, data, cb) {
    // 兼容 emit(evt, cb) 与 emit(evt, data, cb)
    if (typeof data === 'function') { cb = data; data = undefined; }
    emitted.push({ evt, data });
    if (typeof cb === 'function') ackCalls.push({ evt, data, cb });
  }
};

class FakePC {
  constructor() { this.remoteDescription = null; this.localDescription = { type: 'offer', sdp: 'o' }; this.connectionState = 'new'; }
  addTrack() {}
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'o' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'a' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  close() {}
}

const mediaStream = {
  _muted: false,
  getTracks() { return this.getAudioTracks(); },
  getAudioTracks() { return [{ enabled: !this._muted, stop() {}, set enabled(v) { this._muted = !v; } }]; }
};

global.window = windowStub;
global.document = documentStub;
global.io = () => socketStub;
global.RTCPeerConnection = FakePC;
global.confirm = () => true;
// localStorage 桩：预置固定 clientId，验证"自己的历史消息"归属判断
const lsStore = { 'localsend-client-id': 'c-test-user' };
global.localStorage = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => { lsStore[k] = String(v); },
  removeItem: (k) => { delete lsStore[k]; }
};
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => Promise.resolve(mediaStream) } }
});

// 加载 client.js（注册 chatApp）→ share.js → data-panel.js
require(path.join(__dirname, '..', 'public', 'client.js'));
require(path.join(__dirname, '..', 'public', 'share.js'));
require(path.join(__dirname, '..', 'public', 'data-panel.js'));

console.log('--- 数据面板加载 ---');
const tabData = byId['tabData'];
const dataView = byId['dataView'];
const resultsBox = byId['dataResults'];
const keywordInput = byId['dataSearchKeyword'];
const searchBtn = byId['dataSearchBtn'];
const statMessages = byId['statMessages'];

assert(!!tabData && !!dataView, '数据面板 DOM 存在');
assert(tabData._listeners && tabData._listeners.click && tabData._listeners.click.length > 0, '数据 tab 已绑定点击');
assert(typeof socketHandlers.welcome === 'function', 'welcome 监听存在');

console.log('--- 欢迎历史消息渲染 ---');
// 模拟 welcome 带历史
socketHandlers.welcome({
  id: 'me-1', nickname: '我', online: 2,
  history: [
    { id: 'h1', type: 'text', nickname: '张三', text: '昨天的消息', timestamp: 1700000000000, recalled: false, clientId: 'c-other' },
    { id: 'h2', type: 'text', nickname: '李四', text: '被撤回的消息', timestamp: 1700000001000, recalled: true, clientId: 'c-other' },
    { id: 'h3', type: 'file', nickname: '王五', fileName: '报告.pdf', fileSize: 1024, timestamp: 1700000002000, recalled: false, clientId: 'c-other' },
    { id: 'h4', type: 'text', nickname: '旧昵称', text: '我自己的历史消息', timestamp: 1700000003000, recalled: false, clientId: 'c-test-user' }
  ]
});
// chatArea 应渲染了历史（通过 appendMsg）
const chatArea = byId['chatArea'];
assert(chatArea.children.length > 0, '历史消息被渲染进消息区');
const allHtml = chatArea.children.map((c) => c._html || '').join('');
assert(allHtml.includes('昨天的消息'), '包含未撤回文本消息');
assert(allHtml.includes('报告.pdf'), '包含文件消息');
assert(!allHtml.includes('被撤回的消息'), '不含被撤回的消息');
assert(allHtml.includes('历史消息'), '包含历史分隔提示');
// h4：clientId 匹配当前用户 → 应渲染为 self（msg-self，右侧）
const selfMsgs = chatArea.children.filter((c) => (c._html || '').includes('我自己的历史消息'));
assert(selfMsgs.length === 1 && selfMsgs[0].className && selfMsgs[0].className.includes('self'), '匹配 clientId 的历史消息渲染为自己的（右侧）');

console.log('--- 数据面板统计 ---');
// 模拟 history_stats ack
const statsAck = ackCalls.find((a) => a.evt === 'history_stats');
assert(!!statsAck, '加载时请求了统计');
statsAck.cb({ ok: true, messages: 42, files: 5, strokes: 17, dbBytes: 4096, firstAt: 1700000000000, lastAt: 1700000002000 });
assert(String(statMessages.textContent) === '42', '统计消息数渲染');
assert(String(byId['statFiles'].textContent) === '5', '统计文件数渲染');
assert(byId['statDbSize'].textContent === '4.0 KB', '库大小渲染');

console.log('--- 搜索交互 ---');
keywordInput.value = 'SQLite';
const clickHandler = (el, evt) => (el._listeners && el._listeners[evt] || []).forEach((f) => f());
clickHandler(searchBtn, 'click');
const searchCall = ackCalls.find((a) => a.evt === 'history_search');
assert(!!searchCall, '点击搜索发起 history_search');
assert(searchCall.data.keyword === 'SQLite', '搜索关键词正确');
searchCall.cb({ ok: true, results: [{ id: 'h9', type: 'text', nickname: '我', text: 'SQLite 真不错', timestamp: 1700000000000 }] });
const resultHtml = resultsBox.children.map((c) => c._html || '').join('');
assert(resultHtml.includes('SQLite 真不错'), '搜索结果渲染');

console.log('--- 清空历史 ---');
const clearCall = ackCalls.find((a) => a.evt === 'history_clear');
assert(!clearCall, '未点击清空前无 history_clear');
clickHandler(byId['dataClearBtn'], 'click');
const clearCall2 = ackCalls.find((a) => a.evt === 'history_clear');
assert(!!clearCall2, '点击清空发起 history_clear');
assert(clearCall2.data.includeStrokes === true, '清空连带白板');

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
