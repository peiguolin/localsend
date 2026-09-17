/* 时间分隔线（客户端）冒烟测试：跨天消息之间插入 今天/昨天/日期 分隔线；
 * 同时校验 @全员消息的整泡高亮（mentioned）与 @所有人 关键词高亮（mention-all）。 */
'use strict';
const path = require('path');
let failures = 0;
function assert(cond, name) { if (cond) console.log('  ✅', name); else { failures++; console.log('  ❌', name); } }

function makeEl(tag) {
  const el = {
    tagName: tag || 'div', children: [], style: {}, dataset: {},
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }, toggle(c, f) { if (f === undefined) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; } if (f) this._s.add(c); else this._s.delete(c); return !!f; } },
    // 真实 DOM 中 className 与 classList 自动同步（分隔线/消息分类判断依赖）
    set className(v) { this._className = v; this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return this._className || ''; },
    addEventListener(evt, fn) { (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn); },
    appendChild(c) { this.children.push(c); return c; },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } },
    querySelector() { return makeEl('div'); }, querySelectorAll() { return []; },
    focus() {}, scrollTo() {}, play() { return Promise.resolve(); },
    set innerHTML(v) { this._html = v; this.children.length = 0; }, get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    set value(v) { this._value = v; }, get value() { return this._value === undefined ? '' : this._value; },
    set hidden(v) { this._hidden = v; }, get hidden() { return this._hidden === true; }
  };
  return el;
}

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
const socketStub = { on(evt, cb) { socketHandlers[evt] = cb; }, emit() {} };
global.window = windowStub; global.document = documentStub; global.io = () => socketStub;
global.CSS = { escape: (s) => String(s) };
Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: {} } });

byId['chatArea'] = makeChatArea();
require(path.join(__dirname, '..', 'public', 'client.js'));
const app = window.chatApp;
const chatArea = byId['chatArea'];
const state = app.state;
state.myClientId = 'me';
state.myNickname = '我';
state.currentRoom = 'main';

function fireChat(data) { socketHandlers['chat_message'](data); }

function dividers() { return chatArea.children.filter((c) => c.classList.contains('msg-day-divider')); }
function dividerLabels() { return dividers().map((d) => (d._html || '').replace(/<[^>]+>/g, '').trim()); }

// 用「今天正午」为锚点构造各天时间戳（避开午夜前后日期翻转的边界）
const nowNoon = new Date(); nowNoon.setHours(12, 0, 0, 0);
const day = 24 * 3600 * 1000;
const tToday = nowNoon.getTime();
const tYesterday = tToday - day;
const tBefore = tToday - 2 * day;
const tOldYear = new Date(nowNoon.getFullYear() - 1, nowNoon.getMonth(), nowNoon.getDate(), 12).getTime();

console.log('--- 跨天追加：分隔线插入 ---');
fireChat({ id: 'm1', type: 'text', nickname: '张三', clientId: 'a', text: '前天消息', mentions: [], timestamp: tBefore });
fireChat({ id: 'm2', type: 'text', nickname: '张三', clientId: 'a', text: '昨天消息', mentions: [], timestamp: tYesterday });
fireChat({ id: 'm3', type: 'text', nickname: '张三', clientId: 'a', text: '今天消息', mentions: [], timestamp: tToday });
fireChat({ id: 'm4', type: 'text', nickname: '张三', clientId: 'a', text: '今天晚些', mentions: [], timestamp: tToday + 3600 * 1000 });
assert(dividers().length === 2, '跨天消息间插入了 2 条分隔线（昨天 / 今天）');
assert(dividers()[0]._html.includes('昨天'), '第一条分隔线标注「昨天」', dividerLabels().join('|'));
assert(dividers()[1]._html.includes('今天'), '第二条分隔线标注「今天」', dividerLabels().join('|'));
const order = chatArea.children.map((c) => c._html || '').join('|');
assert(order.indexOf('前天消息') < order.indexOf('昨天消息'), '昨天分隔线位于两条消息之间');
assert(order.indexOf('昨天消息') < order.indexOf('今天消息'), '今天分隔线位于两条消息之间');
const i3 = chatArea.children.findIndex((c) => (c._html || '').includes('今天消息'));
const i4 = chatArea.children.findIndex((c) => (c._html || '').includes('今天晚些'));
assert(i4 === i3 + 1, '同日消息之间无分隔线（相邻渲染）', `i3=${i3} i4=${i4}`);

console.log('--- 跨年日期标注 ---');
const beforeYear = dividers().length;
fireChat({ id: 'm5', type: 'text', nickname: '张三', clientId: 'a', text: '去年消息', mentions: [], timestamp: tOldYear });
const yearDivider = dividers()[dividers().length - 1];
assert(dividers().length === beforeYear + 1, '跨年插入分隔线');
assert(yearDivider._html.includes(`${tOldYear === 0 ? '' : '年'}`) || /年/.test(yearDivider._html), '跨年标注带年份', yearDivider._html);

console.log('--- @全员：整泡高亮 + 关键词高亮 ---');
const before = chatArea.children.length;
fireChat({ id: 'm6', type: 'text', nickname: '李四', clientId: 'b', text: '@所有人 今晚八点开会', mentions: [], mentionAll: true, timestamp: tToday + 7200 * 1000 });
const added = chatArea.children[chatArea.children.length - 1];
assert(chatArea.children.length === before + 2, '@全员消息渲染（跨年消息后追加 → 分隔线 + 消息）');
assert(added.className.includes('mentioned'), '@全员消息整泡高亮（mentioned）', added.className);
assert(added._html.includes('mention-all'), '「@所有人」关键词高亮（mention-all）');
const selfDiv = added;
assert(!selfDiv.className.includes('self'), '他人 @全员 消息按 other 渲染');

console.log('--- 历史（无 mentionAll 字段）也能识别 @所有人 ---');
const before2 = chatArea.children.length;
fireChat({ id: 'm7', type: 'text', nickname: '王五', clientId: 'c', text: '大家好 @everyone 集合', mentions: [], timestamp: tToday + 8000 * 1000 });
const last = chatArea.children[chatArea.children.length - 1];
assert(chatArea.children.length === before2 + 1, '历史 @everyone 消息渲染');
assert(last.className.includes('mentioned'), '无 mentionAll 字段时按文本识别 @everyone 并高亮', last.className);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
