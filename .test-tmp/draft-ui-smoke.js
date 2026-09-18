/* 房间草稿（客户端）冒烟：
 * - 输入即按房间存 localStorage
 * - 切房：旧房草稿保留，新房草稿各自恢复，不串
 * - 发送后该房草稿清除
 * - 刷新（重新装配/默认房）后公共房草稿仍在
 * 用精简 DOM 桩直接驱动 app.saveCurrentDraft/restoreDraft 与输入事件。 */
'use strict';
const path = require('path');
let failures = 0;
function assert(cond, name, extra) { if (cond) console.log('  ✅', name); else { failures++; console.log('  ❌', name + (extra !== undefined ? ' — ' + extra : '')); } }
const fire = (el, evt, ev) => (el._listeners && el._listeners[evt] || []).forEach((f) => f(ev || { target: el }));

function makeEl(tag) {
  const el = {
    tagName: tag || 'div', children: [], style: {}, dataset: {},
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); }, contains(c) { return this._s.has(c); }, toggle(c, f) { if (f === undefined) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; } if (f) this._s.add(c); else this._s.delete(c); return !!f; } },
    set className(v) { this._className = v; }, get className() { return this._className || ''; },
    addEventListener(evt, fn) { (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn); },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    remove() {},
    querySelector() { return makeEl('div'); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
    focus() {}, scrollTo() {}, play() { return Promise.resolve(); },
    set innerHTML(v) { this._html = v; this.children = []; }, get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    set value(v) { this._value = v; }, get value() { return this._value === undefined ? '' : this._value; },
    set hidden(v) { this._hidden = v; }, get hidden() { return this._hidden === true; }
  };
  return el;
}
function makeChatArea() {
  return {
    children: [], scrollTop: 0, clientHeight: 100, scrollHeight: 100, _listeners: {},
    addEventListener(e, f) { (this._listeners[e] = this._listeners[e] || []).push(f); },
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); },
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : 0; this.children.splice(i < 0 ? 0 : i, 0, c); },
    scrollTo() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } }
  };
}

const ctxStub = { beginPath() {}, arc() {}, fill() {}, fillText() {}, moveTo() {}, lineTo() {}, closePath() {}, set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {} };
const byId = {};
const documentStub = {
  title: 't', head: makeEl('head'), body: makeEl('body'), visibilityState: 'visible', hasFocus: () => true,
  getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
  querySelector(sel) { if (sel === 'link[rel="icon"]') return null; if (sel === '.inputbar') return makeEl('div'); return makeEl('div'); },
  querySelectorAll() { return []; },
  createElement(t) { if (t === 'canvas') return { width: 0, height: 0, getContext: () => ctxStub, toDataURL: () => 'data:' }; return makeEl(t); },
  addEventListener() {}
};
const socketHandlers = {};
const socketStub = { on(e, cb) { (socketHandlers[e] = socketHandlers[e] ? [].concat(socketHandlers[e], cb) : cb); }, emit() {} };
// 可观察的 localStorage
const ls = {};
global.localStorage = { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } };
global.window = { addEventListener() {}, focus() {}, innerWidth: 1200, chatApp: null, matchMedia: () => ({ addEventListener() {}, matches: false }) };
global.document = documentStub;
global.io = () => socketStub;
global.CSS = { escape: (s) => String(s) };
Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: {} } });

byId['chatArea'] = makeChatArea();
require(path.join(__dirname, '..', 'public', 'client.js'));
const app = window.chatApp;
const state = app.state;
const msgInput = byId['msgInput'];
state.myClientId = 'me'; state.myNickname = '我'; state.currentRoom = 'main';

const DRAFT_KEY = 'localsend-drafts';
const readLS = () => JSON.parse(ls[DRAFT_KEY] || '{}');

console.log('--- 1) 公共房输入即存草稿 ---');
state.currentRoom = 'main';
msgInput.value = '等下再说';
fire(msgInput, 'input');
assert(readLS().main === '等下再说', 'main 草稿已存 localStorage');

console.log('--- 2) 切到群聊 g1：main 草稿保留，g1 为空 ---');
app.saveCurrentDraft();                 // 切房前 rooms 片会调
state.currentRoom = 'g1';
app.restoreDraft('g1');
assert(msgInput.value === '', '切到 g1 输入框为空');
msgInput.value = 'g1 里的草稿';
fire(msgInput, 'input');

console.log('--- 3) 切回 main：恢复 main 草稿，不与 g1 串 ---');
app.saveCurrentDraft();
state.currentRoom = 'main';
app.restoreDraft('main');
assert(msgInput.value === '等下再说', '恢复 main 草稿');
state.currentRoom = 'g1';
app.restoreDraft('g1');
assert(msgInput.value === 'g1 里的草稿', 'g1 草稿独立保留');

console.log('--- 4) 发送后清除该房草稿 ---');
state.currentRoom = 'main';
app.restoreDraft('main');
app.clearDraft('main');
assert(!('main' in readLS()), 'clearDraft 删除 main 键');
state.currentRoom = 'g1';
app.restoreDraft('g1');
assert(readLS().g1 === 'g1 里的草稿', '清除 main 不影响 g1');

console.log('--- 5) 空格草稿不写入 ---');
state.currentRoom = 'main';
msgInput.value = '   ';
fire(msgInput, 'input');
assert(!('main' in readLS()), '纯空白不建草稿键');

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
