// DOM 桩冒烟测试：粘贴截图即发送（方案 A）
// 验证：
//  - 剪贴板含图片时粘贴 → 接管（preventDefault）+ 走 uploadFile 上传链路
//  - 纯文本粘贴 → 不接管、不触发上传
//  - 群聊弹窗打开时粘贴 → 不接管
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
  on(evt, cb) { socketHandlers[evt] = cb; },
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
  // ---------- 场景 1：剪贴板含图片 → 接管 + 上传 ----------
  console.log('--- 图片粘贴：接管并发送 ---');
  let prevented = false;
  const imgBlob = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'clip.png', { type: 'image/png' });
  const before = fetchCalls.length;
  pasteHandler({
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imgBlob }] },
    preventDefault: () => { prevented = true; }
  });
  assert(prevented === true, '图片粘贴被接管（preventDefault）');
  await sleep(50); // 等 uploadFile 异步链完成
  const initCall = fetchCalls.find((c) => c.url.includes('/upload/init'));
  assert(!!initCall, '发起 /upload/init');
  assert(!!initCall && String(initCall.opts.body).includes(encodeURIComponent('粘贴图片-')), 'init 文件名含「粘贴图片」');
  const completeCall = fetchCalls.find((c) => c.url.includes('/upload/complete'));
  assert(!!completeCall, '发起 /upload/complete');
  const compFd = completeCall && completeCall.opts.body;
  const compEntries = compFd && typeof compFd.entries === 'function' ? Array.from(compFd.entries()) : [];
  const origName = String((compEntries.find(([k]) => k === 'originalName') || [])[1] || '');
  assert(!!completeCall && origName.includes(encodeURIComponent('粘贴图片-')), 'complete originalName 含「粘贴图片」', origName);
  assert(fetchCalls.length > before, '上传链路被触发');

  // ---------- 场景 2：纯文本粘贴 → 不接管 ----------
  console.log('--- 纯文本粘贴：不拦截 ---');
  const textBefore = fetchCalls.length;
  let prevented2 = false;
  pasteHandler({
    clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] },
    preventDefault: () => { prevented2 = true; }
  });
  assert(prevented2 === false, '文本粘贴不 preventDefault');
  await sleep(30);
  assert(fetchCalls.length === textBefore, '文本粘贴不触发上传');

  // ---------- 场景 3：群聊弹窗打开 → 不接管 ----------
  console.log('--- 群聊弹窗打开时粘贴：不接管 ---');
  const modalBefore = fetchCalls.length;
  byId['groupModal'].hidden = false; // 弹窗打开
  let prevented3 = false;
  pasteHandler({
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => imgBlob }] },
    preventDefault: () => { prevented3 = true; }
  });
  await sleep(30);
  assert(prevented3 === false, '弹窗打开时图片粘贴不接管');
  assert(fetchCalls.length === modalBefore, '弹窗打开时不触发上传');
  byId['groupModal'].hidden = true; // 关闭，还原

  // ---------- 场景 4：Linux 场景——items 读不到图片，Clipboard API 兜底 ----------
  console.log('--- Linux 兜底：items 无图片 → clipboard.read() 拿到图片发送 ---');
  clipboardStore.image = new File([new Uint8Array([9, 8, 7])], 'screenshot.png', { type: 'image/png' });
  const fbkBefore = fetchCalls.length;
  let prevented4 = false;
  pasteHandler({
    clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] },
    preventDefault: () => { prevented4 = true; }
  });
  await sleep(60); // 等异步 clipboard.read() + uploadFile 完成
  const fbkInit = fetchCalls.slice(fbkBefore).find((c) => c.url.includes('/upload/init'));
  assert(!!fbkInit, '兜底路径发起 /upload/init');
  assert(!!fbkInit && String(fbkInit.opts.body).includes(encodeURIComponent('粘贴图片-')), '兜底文件名含「粘贴图片」');
  clipboardStore.image = null;

  // ---------- 场景 5：items 有 file 但非图片 + 剪贴板无图 → 诊断提示 ----------
  console.log('--- 剪贴板无法读取为图片 → 诊断提示 ---');
  const diagBefore = fetchCalls.length;
  byId['uploadHint']._text = '';
  pasteHandler({
    clipboardData: { items: [{ kind: 'file', type: 'application/octet-stream', getAsFile: () => new File([new Uint8Array([1])], 'x.bin', { type: 'application/octet-stream' }) }] },
    preventDefault: () => {}
  });
  await sleep(60);
  assert(!!byId['uploadHint']._text && byId['uploadHint']._text.includes('无法读取为图片'), '给出诊断提示');
  assert(fetchCalls.length === diagBefore, '诊断场景不触发上传');

  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
