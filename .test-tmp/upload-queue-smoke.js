// 上传队列冒烟测试（DOM/fetch/socket 全桩，不启服务器）：
//  - 多文件入队：queueFile 逐项入队，托盘同时显示多个文件
//  - 多文件 + 配文 → 配文作为独立 chat_message 先发，文件各自 complete（不带 text）
//  - 单文件 + 配文 → 图文同发（complete 带 text）
//  - 取消：发送中 cancelPending → 队列移除 + 调用 /upload/abort + 不再 complete
//  - 失败重试：complete 失败 → 状态 error + 托盘出现「重试」→ retryPending → 重发成功移出队列
'use strict';
const path = require('path');

let failures = 0;
function assert(cond, name, extra) {
  if (cond) console.log('  ✅', name);
  else { failures++; console.log('  ❌', name + (extra !== undefined ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    querySelector(sel) { this._qs = this._qs || {}; if (!this._qs[sel]) this._qs[sel] = makeEl('span'); return this._qs[sel]; },
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
byId['groupModal'] = makeEl('div');
byId['groupModal'].hidden = true;

const documentStub = {
  title: '局域网聊天室',
  head: makeEl('head'),
  body: makeEl('body'),
  visibilityState: 'visible',
  hasFocus: () => false,
  addEventListener(evt, fn) {
    (this._listeners = this._listeners || {})[evt] = (this._listeners[evt] || []).concat(fn);
  },
  getElementById(id) { return byId[id] || (byId[id] = makeEl('div')); },
  querySelector(sel) {
    if (sel === 'link[rel="icon"]') return null;
    return makeEl('div');
  },
  querySelectorAll() { return []; },
  createElement(tag) {
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ctxStub, toDataURL: () => 'data:image/png;base64,AAAA' };
    return makeEl(tag);
  }
};

const windowStub = { addEventListener() {}, focus() {} };
const socketHandlers = {};
const emitted = [];
const socketStub = {
  on(evt, cb) {
    const prev = socketHandlers[evt];
    socketHandlers[evt] = prev ? (...args) => { prev(...args); cb(...args); } : cb;
  },
  emit(evt, data) { emitted.push({ evt, data }); }
};

// fetch 桩：可编程失败 / 挂起分片 / 记录 complete / abort
const fetchCalls = [];
const chunkGates = [];
let failCompleteOnce = false;
let gateChunks = false;
global.fetch = (url, opts) => {
  fetchCalls.push({ url: String(url), opts: opts || {} });
  const u = String(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/upload/init')) {
    return Promise.resolve(json({ ok: true, uploadId: 'up-q', chunkSize: 1024 * 1024, totalChunks: 1, received: [] }));
  }
  if (u.includes('/upload/chunk')) {
    if (gateChunks) return new Promise((res) => chunkGates.push(() => res(new Response('ok', { status: 200 }))));
    return Promise.resolve(new Response('ok', { status: 200 }));
  }
  if (u.includes('/upload/complete')) {
    if (failCompleteOnce) { failCompleteOnce = false; return Promise.resolve(json({ ok: false, error: '模拟合并失败' })); }
    return Promise.resolve(json({ ok: true, type: 'file', storedName: 'stored.bin', downloadUrl: '/download/stored.bin', fileName: 'x.bin', size: 10 }));
  }
  if (u.includes('/upload/abort')) {
    return Promise.resolve(json({ ok: true }));
  }
  return Promise.resolve(json({ ok: false, error: 'unhandled' }));
};

global.localStorage = { getItem: (k) => (k === 'localsend-client-id' ? 'c-queue-user' : null), setItem: () => {}, removeItem: () => {} };
global.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };
global.window = windowStub;
global.document = documentStub;
global.CSS = { escape: (s) => String(s) };
global.io = () => socketStub;
global.RTCPeerConnection = class { addTrack() {} createOffer() { return Promise.resolve({ type: 'offer', sdp: 'o' }); } createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'a' }); } setLocalDescription() { return Promise.resolve(); } setRemoteDescription() { return Promise.resolve(); } addIceCandidate() { return Promise.resolve(); } close() {} };
global.confirm = () => true;
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [], getAudioTracks: () => [] }) }, clipboard: {} }
});

require(path.join(__dirname, '..', 'public', 'client.js'));

const compFormData = (call) => {
  const e = call && call.opts && call.opts.body && typeof call.opts.body.entries === 'function' ? Array.from(call.opts.body.entries()) : [];
  return new Map(e);
};

(async () => {
  const app = window.chatApp;
  const tray = byId['attachTray'];
  const mkFile = (name, size) => new File([new Uint8Array(size || 4)], name, { type: 'application/octet-stream', lastModified: Date.now() });

  console.log('--- 多文件入队 ---');
  app.queueFile(mkFile('甲.bin'));
  app.queueFile(mkFile('乙.bin'));
  assert(app.hasPendingAttachment() === true, '两个文件都在队列');
  const html0 = String(tray.innerHTML);
  assert(html0.includes('甲.bin') && html0.includes('乙.bin'), '托盘同时显示两个文件', html0.slice(0, 120));
  assert(tray.hidden === false, '托盘可见');

  console.log('--- 多文件 + 配文：配文独立先发，文件各自 complete ---');
  const before = fetchCalls.length;
  const res1 = await app.sendAttachment('群文件说明');
  assert(res1 && res1.ok === true, 'sendAttachment(多文件) 成功', JSON.stringify(res1));
  const sepMsg = emitted.find((e) => e.evt === 'chat_message');
  assert(!!sepMsg && sepMsg.data.text === '群文件说明', '配文作为独立 chat_message 发出', JSON.stringify(sepMsg && sepMsg.data));
  const completes = fetchCalls.filter((c) => c.url.includes('/upload/complete'));
  assert(completes.length === 2, '两个文件各自 complete', String(completes.length));
  const capA = String(compFormData(completes[0]).get('text') || '');
  const capB = String(compFormData(completes[1]).get('text') || '');
  assert(capA === '' && capB === '', '多文件 complete 不带配文', capA + '/' + capB);
  assert(app.hasPendingAttachment() === false, '发送成功后队列清空');
  assert(fetchCalls.filter((c) => c.url.includes('/upload/chunk')).length === 2, '两个文件各传 1 个分片');

  console.log('--- 单文件 + 配文：图文同发 ---');
  app.queueFile(mkFile('丙.png'));
  await app.sendAttachment('这张图配文字');
  const comp2 = fetchCalls.filter((c) => c.url.includes('/upload/complete'));
  const lastComp = comp2[comp2.length - 1];
  assert(String(compFormData(lastComp).get('text')) === '这张图配文字', '单文件 complete 带配文');
  assert(app.hasPendingAttachment() === false, '发送后清空');

  console.log('--- 取消：发送中取消 → 移除队列 + abort + 不 complete ---');
  gateChunks = true;
  app.queueFile(mkFile('大文件.bin', 5 * 1024 * 1024));
  const pSend = app.sendAttachment('');
  await sleep(120); // 让 init/hash 完成、分片请求挂起
  assert(app.hasPendingAttachment() === true, '发送中仍在队列');
  app.cancelPending(0);
  assert(app.hasPendingAttachment() === false, '取消后移出队列');
  await sleep(40);
  const abortCall = fetchCalls.filter((c) => c.url.includes('/upload/abort'));
  assert(abortCall.length >= 1, '取消时调用 /upload/abort', JSON.stringify(abortCall));
  chunkGates.splice(0).forEach((g) => g()); // 放行挂起分片
  const resCancel = await pSend;
  assert(resCancel && resCancel.ok === true, 'sendAttachment 对纯取消返回 ok');
  const completes3 = fetchCalls.filter((c) => c.url.includes('/upload/complete'));
  assert(completes3.length === 3, '取消的上传不再 complete', String(completes3.length));
  gateChunks = false;

  console.log('--- 失败重试：complete 失败 → error + 重试 → 成功 ---');
  failCompleteOnce = true;
  app.queueFile(mkFile('丁.bin'));
  const resFail = await app.sendAttachment('');
  assert(resFail && resFail.ok === false, 'complete 失败时 sendAttachment 返回失败', JSON.stringify(resFail));
  assert(String(tray.innerHTML).includes('重试'), '失败后托盘出现「重试」按钮', String(tray.innerHTML).slice(0, 150));
  assert(String(tray.innerHTML).includes('模拟合并失败'), '托盘显示失败原因');
  assert(app.hasPendingAttachment() === true, '失败文件保留在队列');
  app.retryPending(0);
  await sleep(250); // 重试：hash + init + chunk + complete
  assert(app.hasPendingAttachment() === false, '重试成功后移出队列（不重复发送）');
  const completes4 = fetchCalls.filter((c) => c.url.includes('/upload/complete'));
  assert(completes4.length === 5, '重试产生新的 complete（2+1+0+1 失败 +1 重试）', String(completes4.length));

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
