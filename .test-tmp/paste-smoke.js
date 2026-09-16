// DOM 桩冒烟测试：粘贴截图 → 入待发预览托盘（不再立即发送）
// 验证：
//  - 剪贴板含图片时粘贴 → 接管（preventDefault）+ 入托盘，不触发上传
//  - sendAttachment(配文) → 才走上传链路，complete 带 text 配文
//  - 纯文本粘贴 → 不接管；群聊弹窗打开时粘贴 → 不接管
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
// 与真实 HTML 一致：群聊弹窗初始 hidden（桩 makeEl 默认 hidden=false）
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
const socketStub = {
  on(evt, cb) {
    // 真实 socket 同事件可挂多个监听；链式合并保持 socketHandlers[evt](...) 调用形式
    const prev = socketHandlers[evt];
    socketHandlers[evt] = prev ? (...args) => { prev(...args); cb(...args); } : cb;
  },
  emit(evt, data, cb) { if (typeof cb === 'function') cb({ ok: true, history: [] }); }
};

// fetch 桩：记录调用，返回模拟上传链路响应
const fetchCalls = [];
global.fetch = (url, opts) => {
  fetchCalls.push({ url: String(url), opts: opts || {} });
  const u = String(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/upload/init')) {
    return Promise.resolve(json({ ok: true, uploadId: 'up-1', chunkSize: 1024 * 1024, totalChunks: 1, received: [] }));
  }
  if (u.includes('/upload/chunk')) {
    return Promise.resolve(new Response('ok', { status: 200 }));
  }
  if (u.includes('/upload/complete')) {
    return Promise.resolve(json({ ok: true, type: 'image', storedName: 'stored.png', downloadUrl: '/download/stored.png', fileName: '粘贴图片-x.png', size: 4 }));
  }
  return Promise.resolve(json({ ok: false, error: 'unhandled' }));
};

const lsStore = { 'localsend-client-id': 'c-test-user' };
global.localStorage = { getItem: (k) => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = String(v); }, removeItem: (k) => { delete lsStore[k]; } };
global.URL = global.URL || {};
global.URL.createObjectURL = () => 'blob:stub';
global.URL.revokeObjectURL = () => {};
global.window = windowStub;
global.document = documentStub;
global.CSS = { escape: (s) => String(s) };
global.io = () => socketStub;
global.RTCPeerConnection = class { addTrack() {} createOffer() { return Promise.resolve({ type: 'offer', sdp: 'o' }); } createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'a' }); } setLocalDescription() { return Promise.resolve(); } setRemoteDescription() { return Promise.resolve(); } addIceCandidate() { return Promise.resolve(); } close() {} };
global.confirm = () => true;
// 可变"剪贴板"模拟：截图工具把图片写入剪贴板后，Clipboard API read() 才能读到
const clipboardStore = { image: null };
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [], getAudioTracks: () => [] }) },
    clipboard: {
      read: () => {
        if (!clipboardStore.image) return Promise.resolve([]);
        return Promise.resolve([{ types: [clipboardStore.image.type], getType: async () => clipboardStore.image }]);
      }
    }
  }
});

require(path.join(__dirname, '..', 'public', 'client.js'));

const pasteHandler = ((documentStub._listeners && documentStub._listeners.paste) || [])[0];
assert(!!pasteHandler, 'paste 监听已注册');

(async () => {
  const app = window.chatApp;
  const tray = byId['attachTray'];

  // ---------- 场景 1：剪贴板含图片 → 接管 + 入托盘（不立即上传） ----------
  console.log('--- 图片粘贴：接管并入待发托盘 ---');
  let prevented = false;
  const imgBlob = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'clip.png', { type: 'image/png' });
  const before = fetchCalls.length;
  pasteHandler({
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imgBlob }] },
    preventDefault: () => { prevented = true; }
  });
  assert(prevented === true, '图片粘贴被接管（preventDefault）');
  await sleep(20);
  assert(app.hasPendingAttachment() === true, '附件进入待发托盘');
  assert(tray.hidden === false && String(tray.innerHTML).includes('粘贴图片-'), '托盘显示待发图片');
  assert(fetchCalls.length === before, '入托盘阶段不触发上传');

  // ---------- 场景 2：发送（带配文）→ 才走上传链路，complete 带 text ----------
  console.log('--- 发送附件 + 配文 ---');
  const res = await app.sendAttachment('这是图片说明 @机器人');
  assert(res && res.ok === true, 'sendAttachment 返回成功');
  const initCall = fetchCalls.find((c) => c.url.includes('/upload/init'));
  assert(!!initCall, '发起 /upload/init');
  const completeCall = fetchCalls.find((c) => c.url.includes('/upload/complete'));
  assert(!!completeCall, '发起 /upload/complete');
  const compEntries = completeCall && typeof completeCall.opts.body.entries === 'function' ? Array.from(completeCall.opts.body.entries()) : [];
  const origName = String((compEntries.find(([k]) => k === 'originalName') || [])[1] || '');
  assert(origName.includes(encodeURIComponent('粘贴图片-')), 'complete originalName 含「粘贴图片」', origName);
  const caption = String((compEntries.find(([k]) => k === 'text') || [])[1] || '');
  assert(caption === '这是图片说明 @机器人', 'complete 带文字配文', caption);
  assert(app.hasPendingAttachment() === false, '发送成功后清空托盘');

  // ---------- 场景 3：纯文本粘贴 → 不接管 ----------
  console.log('--- 纯文本粘贴：不拦截 ---');
  const textBefore = fetchCalls.length;
  let prevented2 = false;
  pasteHandler({
    clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] },
    preventDefault: () => { prevented2 = true; }
  });
  assert(prevented2 === false, '文本粘贴不 preventDefault');
  await sleep(20);
  assert(fetchCalls.length === textBefore && app.hasPendingAttachment() === false, '文本粘贴不入托盘/不上传');

  // ---------- 场景 4：群聊弹窗打开 → 不接管 ----------
  console.log('--- 群聊弹窗打开时粘贴：不接管 ---');
  byId['groupModal'].hidden = false;
  let prevented3 = false;
  pasteHandler({
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imgBlob }] },
    preventDefault: () => { prevented3 = true; }
  });
  await sleep(20);
  assert(prevented3 === false, '弹窗打开时图片粘贴不接管');
  assert(app.hasPendingAttachment() === false, '弹窗打开时不入托盘');
  byId['groupModal'].hidden = true;

  // ---------- 场景 5：Linux 兜底——items 无图片，clipboard.read() 拿到图片入托盘 ----------
  console.log('--- Linux 兜底：clipboard.read() 拿到图片入托盘 ---');
  clipboardStore.image = new File([new Uint8Array([9, 8, 7])], 'screenshot.png', { type: 'image/png' });
  const fbkBefore = fetchCalls.length;
  pasteHandler({
    clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] },
    preventDefault: () => {}
  });
  await sleep(40);
  assert(app.hasPendingAttachment() === true, '兜底图片入托盘');
  assert(fetchCalls.length === fbkBefore, '兜底入托盘阶段不上传');
  app.clearAttachment();
  clipboardStore.image = null;

  // ---------- 场景 6：file 但非图片 + 剪贴板无图 → 诊断提示 ----------
  console.log('--- 剪贴板无法读取为图片 → 诊断提示 ---');
  const diagBefore = fetchCalls.length;
  byId['uploadHint']._text = '';
  pasteHandler({
    clipboardData: { items: [{ kind: 'file', type: 'application/octet-stream', getAsFile: () => new File([new Uint8Array([1])], 'x.bin', { type: 'application/octet-stream' }) }] },
    preventDefault: () => {}
  });
  await sleep(40);
  assert(!!byId['uploadHint']._text && byId['uploadHint']._text.includes('无法读取为图片'), '给出诊断提示');
  assert(fetchCalls.length === diagBefore && app.hasPendingAttachment() === false, '诊断场景不入托盘/不上传');

  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
