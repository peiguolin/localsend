/* 历史分页（客户端懒加载）冒烟测试：顶部滚动触发 history_page、更早消息逆序前插保持升序、
 * 视口滚动位置补偿、initHistoryState 初始化/重置。 */
'use strict';
const path = require('path');
let failures = 0;
function assert(cond, name) { if (cond) console.log('  ✅', name); else { failures++; console.log('  ❌', name); } }

function makeEl(tag) {
  const el = {
    tagName: tag || 'div', children: [], style: {}, dataset: {},
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }, toggle(c, f) { if (f === undefined) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; } if (f) this._s.add(c); else this._s.delete(c); return !!f; } },
    addEventListener(evt, fn) { (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn); },
    appendChild(c) { this.children.push(c); return c; },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } },
    querySelector() { return makeEl('div'); }, querySelectorAll() { return []; },
    focus() {}, scrollTo() {}, play() { return Promise.resolve(); },
    set innerHTML(v) { this._html = v; this.children.length = 0; }, get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    set value(v) { this._value = v; }, get value() { return this._value === undefined ? '' : this._value; },
    set hidden(v) { this._hidden = v; }, get hidden() { return this._hidden === true; },
    set srcObject(v) { this._srcObject = v; }
  };
  return el;
}

// 带真实滚动几何 + 子节点顺序跟踪的聊天区
function makeChatArea() {
  const area = {
    children: [], scrollTop: 2000, clientHeight: 100, scrollHeight: 2100, _listeners: {},
    addEventListener(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); },
    get firstChild() { return this.children[0] || null; },
    _attach(c) { c._parent = area; area.scrollHeight += 40; },
    appendChild(c) { this._attach(c); this.children.push(c); },
    insertBefore(c, ref) {
      this._attach(c);
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(i < 0 ? 0 : i, 0, c);
    },
    scrollTo(opts) { if (opts && opts.top !== undefined) this.scrollTop = opts.top; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } }
  };
  return area;
}

const ctxStub = { beginPath() {}, arc() {}, fill() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {},
  set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {} };
const byId = {};
const documentStub = {
  title: 't', head: makeEl('head'), body: makeEl('body'), visibilityState: 'visible', hasFocus: () => true,
  getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
  querySelector(sel) { if (sel === 'link[rel="icon"]') return null; return makeEl('div'); },
  createElement(tag) { if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ctxStub, toDataURL: () => 'data:' }; return makeEl(tag); },
  addEventListener() {}
};
const windowStub = { addEventListener() {}, focus() {}, innerWidth: 1200 };
const socketHandlers = {};
const emitted = [];
const socketStub = {
  on(evt, cb) { const p = socketHandlers[evt]; socketHandlers[evt] = p ? (...a) => { p(...a); cb(...a); } : cb; },
  emit(evt, data, cb) {
    emitted.push({ evt, data });
    if (evt === 'history_page' && typeof cb === 'function') {
      // 异步返回更早两条（numericId 8、9），模拟真实 socket 回包
      setTimeout(() => cb({ ok: true, room: 'main', history: [
        { id: 'm8', numericId: 8, type: 'text', room: 'main', nickname: '张三', clientId: 'c8', text: '更早8', mentions: [], timestamp: 8 },
        { id: 'm9', numericId: 9, type: 'text', room: 'main', nickname: '张三', clientId: 'c8', text: '更早9', mentions: [], timestamp: 9 }
      ] }), 0);
    } else if (evt === 'history_page') setTimeout(() => cb && cb({ ok: true, history: [] }), 0);
  }
};
global.window = windowStub; global.document = documentStub; global.io = () => socketStub; global.CSS = { escape: (s) => String(s) };
Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: {} } });

byId['chatArea'] = makeChatArea();
require(path.join(__dirname, '..', 'public', 'client.js'));
const app = window.chatApp;
const chatArea = byId['chatArea'];
const state = app.state;
state.myClientId = 'me';
state.myNickname = '我';
state.currentRoom = 'main';

console.log('--- initHistoryState ---');
// 先塞两条"已加载"历史（numericId 10、11）
chatArea.children.push(makeEl('div'), makeEl('div')); // 占位（原始内容），不占高度
app.initHistoryState([{ id: 'm10', numericId: 10, timestamp: 10 }, { id: 'm11', numericId: 11, timestamp: 11 }]);
assert(state.oldestId === 10, 'oldestId = 10');
assert(state.historyDone === true, 'history.length(2) < 200 → 无更早');
assert(state.historyLoading === false, 'loading 复位');

console.log('--- 顶部滚动触发分页 ---');
state.historyDone = false; // 模拟历史超过一页
chatArea.scrollTop = 0;
const scrollFn = (chatArea._listeners.scroll || [])[0];
scrollFn();
assert(emitted.some((e) => e.evt === 'history_page' && e.data.beforeId === 10 && e.data.room === 'main'), '发出 history_page(beforeId=10)');
assert(state.historyLoading === true, 'loading = true（异步中）');

setTimeout(() => {
  console.log('--- 加载完成：前插 + 滚动补偿 ---');
  const texts = chatArea.children.filter((c) => c && c._html).map((c) => {
    const m = c._html.match(/msg-bubble">([^<]+)</);
    return m ? m[1] : '';
  }).filter(Boolean);
  assert(chatArea.children.length === 4, '新增 2 条更早消息（占位 2 + 更早 2）');
  assert(texts[0] === '更早8' && texts[1] === '更早9', '前插保持升序（更早8 → 更早9）', texts.join(','));
  assert(state.oldestId === 8, 'oldestId 更新为 8');
  assert(state.historyLoading === false, 'loading 复位');
  assert(chatArea.scrollTop === 80, 'scrollTop 补偿新增高度（0→80）', String(chatArea.scrollTop));

  console.log('--- 重置（切房） ---');
  app.initHistoryState();
  assert(state.oldestId === 0 && state.historyDone === true, '重置后无更早可加载');

  console.log(failures === 0 ? '\n✅ 历史分页（客户端）全部通过' : `\n❌ ${failures} 项失败`);
  process.exit(failures ? 1 : 0);
}, 100);
