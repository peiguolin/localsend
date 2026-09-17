/* 表情回应（客户端）冒烟：渲染出 🙂 添加按钮 → 点击弹出表情板 → 点表情发出
 * message_reaction → 收到广播后 chip 出现在气泡下。用于定位"添加不了表情"问题。 */
'use strict';
const path = require('path');
let failures = 0;
function assert(cond, name, extra) { if (cond) console.log('  ✅', name); else { failures++; console.log('  ❌', name + (extra !== undefined ? ' — ' + extra : '')); } }

function makeEl(tag) {
  const el = {
    tagName: tag || 'div', children: [], style: {}, dataset: {}, _parent: null,
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }, toggle(c, f) { if (f === undefined) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; } if (f) this._s.add(c); else this._s.delete(c); return !!f; } },
    set className(v) { this._className = v; this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return this._className || ''; },
    addEventListener(evt, fn) { (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn); },
    appendChild(c) { c._parent = this; this.children.push(c); return c; },
    insertBefore(c, ref) { c._parent = this; const i = ref ? this.children.indexOf(ref) : this.children.length; this.children.splice(i < 0 ? 0 : i, 0, c); },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } },
    querySelector(sel) {
      // 支持类选择器与 [data-mid="..."] 属性选择器
      const cls = String(sel).replace(/^\./, '');
      const attr = /^\[data-([a-z]+)="([^"]*)"\]$/.exec(String(sel));
      const match = (e) => attr ? e.dataset && e.dataset[attr[1]] === attr[2] : e.classList.contains(cls);
      const walk = (els) => { for (const e of els) { if (match(e)) return e; const r = walk(e.children || []); if (r) return r; } return null; };
      return walk(this.children);
    },
    querySelectorAll(sel) {
      const cls = String(sel).replace(/^\./, '');
      const out = [];
      const walk = (els) => { for (const e of els) { if (e.classList.contains(cls)) out.push(e); walk(e.children || []); } };
      walk(this.children);
      return out;
    },
    getBoundingClientRect() { return { left: 100, top: 100, width: 22, height: 22, right: 122, bottom: 122 }; },
    offsetWidth: 120, offsetHeight: 80,
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
    insertBefore(c, ref) { this._attach(c); const i = ref ? this.children.indexOf(ref) : this.children.length; this.children.splice(i < 0 ? 0 : i, 0, c); },
    scrollTo(opts) { if (opts && opts.top !== undefined) this.scrollTop = opts.top; },
    querySelector(sel) {
      // 支持类选择器与 [data-mid="..."] 属性选择器
      const cls = String(sel).replace(/^\./, '');
      const attr = /^\[data-([a-z]+)="([^"]*)"\]$/.exec(String(sel));
      const match = (e) => attr ? e.dataset && e.dataset[attr[1]] === attr[2] : e.classList.contains(cls);
      const walk = (els) => { for (const e of els) { if (match(e)) return e; const r = walk(e.children || []); if (r) return r; } return null; };
      return walk(this.children);
    },
    querySelectorAll() { return []; },
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
const emitted = [];
const socketStub = {
  on(evt, cb) { socketHandlers[evt] = cb; },
  emit(evt, data) { emitted.push({ evt, data }); }
};
const socketHandlers = {};
global.window = windowStub; global.document = documentStub; global.io = () => socketStub;
global.CSS = { escape: (s) => String(s) };
Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: {} } });

byId['chatArea'] = makeChatArea();
require(path.join(__dirname, '..', 'public', 'client.js'));
const app = window.chatApp;
const state = app.state;
const chatArea = byId['chatArea'];
state.myClientId = 'me';
state.myNickname = '我';
state.currentRoom = 'main';

const click = (el, evt) => { const fns = (el._listeners && el._listeners[evt]) || []; fns.forEach((f) => f({ stopPropagation() {} })); };
const qsAll = (root, cls) => root.querySelectorAll('.' + cls);

console.log('--- 渲染：🙂 添加按钮出现在气泡下 ---');
socketHandlers['chat_message']({ id: 'r1', type: 'text', nickname: '张三', clientId: 'a', text: '来点表情', mentions: [], timestamp: Date.now() });
const msgEl = chatArea.children[chatArea.children.length - 1];
const footer = msgEl.querySelector('.msg-footer');
assert(!!footer, '消息有 footer');
const addBtn = msgEl.querySelector('.reaction-add-btn');
assert(!!addBtn && addBtn.textContent === '🙂', 'footer 里有 🙂 添加按钮', addBtn && addBtn.textContent);

console.log('--- 点击 🙂 → 弹出表情板 ---');
click(addBtn, 'click');
const picker = documentStub.body.children.find((c) => c.classList.contains('reaction-picker'));
assert(!!picker, '弹出了表情选择板');
assert(picker.children.length === 16, '表情板有 16 个表情', String(picker.children.length));

console.log('--- 点表情 → 发出 message_reaction ---');
const firstEmoji = picker.children[0];
click(firstEmoji, 'click');
const sent = emitted.find((e) => e.evt === 'message_reaction');
assert(!!sent, '发出了 message_reaction');
assert(sent.data.msgId === 'r1' && sent.data.room === 'main' && sent.data.emoji === firstEmoji.textContent, '参数正确', JSON.stringify(sent && sent.data));

console.log('--- 收到广播 → chip 出现在气泡下 ---');
socketHandlers['message_reaction']({
  room: 'main', msgId: 'r1', action: 'add', clientId: 'me', nickname: '我', emoji: firstEmoji.textContent,
  reactions: [{ emoji: firstEmoji.textContent, count: 1, clientIds: ['me'], names: ['我'] }]
});
const chips = qsAll(msgEl, 'reaction-chip');
assert(chips.length === 1, '气泡下出现 1 个表情 chip', String(chips.length));
assert(chips[0].dataset.emoji === firstEmoji.textContent, 'chip 表情正确', chips[0] && chips[0].dataset.emoji);
assert(chips[0].classList.contains('mine'), '自己的回应标记 mine');
assert(msgEl.querySelector('.reaction-add-btn') !== null, '🙂 添加按钮仍在');

console.log('--- 再点 chip（toggle 取消）→ 广播空列表 → chip 消失 ---');
click(chips[0], 'click');
const sent2 = emitted.filter((e) => e.evt === 'message_reaction');
assert(sent2.length === 2 && sent2[1].data.msgId === 'r1' && sent2[1].data.emoji === firstEmoji.textContent, '再次点击发出取消 message_reaction');
socketHandlers['message_reaction']({ room: 'main', msgId: 'r1', action: 'remove', clientId: 'me', nickname: '我', emoji: firstEmoji.textContent, reactions: [] });
assert(qsAll(msgEl, 'reaction-chip').length === 0, '广播空列表后 chip 移除');
assert(msgEl.querySelector('.reaction-add-btn') !== null, '🙂 添加按钮保留');

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
