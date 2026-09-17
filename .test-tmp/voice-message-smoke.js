/* 语音消息（客户端）冒烟测试：模拟 MediaRecorder 录音 → 停止自动发送 →
 * 校验 complete 携带 audio=1 与「语音消息-*.webm」文件名、语音气泡渲染；另测取消录音不发。 */
'use strict';
const path = require('path');
let failures = 0;
function assert(cond, name, extra) { if (cond) console.log('  ✅', name); else { failures++; console.log('  ❌', name + (extra !== undefined ? ' — ' + extra : '')); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitUntil(fn, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function makeEl(tag) {
  const el = {
    tagName: tag || 'div', children: [], style: {}, dataset: {},
    classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }, toggle(c, f) { if (f === undefined) { if (this._s.has(c)) { this._s.delete(c); return false; } this._s.add(c); return true; } if (f) this._s.add(c); else this._s.delete(c); return !!f; } },
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

// ---------- 假 MediaRecorder / 麦克风 / fetch ----------
class FakeRecorder {
  static isTypeSupported() { return true; }
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = (opts && opts.mimeType) || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    FakeRecorder.instances.push(this);
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    // 带 WebM(EBML) 魔数的假音频数据
    const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8])], { type: this.mimeType });
    if (this.ondataavailable) this.ondataavailable({ data: blob });
    if (this.onstop) this.onstop();
  }
}
FakeRecorder.instances = [];
// 上传分片里的裸标识符 MediaRecorder 走全局作用域（Node 无此全局，需注入）
global.MediaRecorder = FakeRecorder;

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
const windowStub = { addEventListener() {}, focus() {}, innerWidth: 1200, MediaRecorder: FakeRecorder };
const socketHandlers = {};
const socketStub = { on(evt, cb) { socketHandlers[evt] = cb; }, emit() {} };

// fetch 桩：记录调用；/upload/init 1 分片；complete 返回 audio 消息
const calls = [];
let completeBody = null;
global.fetch = (url, opts) => {
  calls.push({ url: String(url), opts });
  let body;
  if (url === '/upload/init') body = { ok: true, uploadId: 'u1', chunkSize: 2097152, totalChunks: 1, received: [] };
  else if (url === '/upload/chunk') body = { ok: true };
  else if (url === '/upload/complete') {
    body = { ok: true, type: 'file', audio: true, id: 'm1', downloadUrl: '/download/v.webm', fileName: '语音消息-x.webm', size: 12, nickname: '我', clientId: 'me', room: 'main', timestamp: Date.now() };
    completeBody = body;
  } else body = { ok: false, error: 'unknown' };
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};
global.window = windowStub; global.document = documentStub; global.io = () => socketStub;
global.CSS = { escape: (s) => String(s) };
Object.defineProperty(global, 'navigator', { configurable: true, value: {
  mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) }
} });

byId['chatArea'] = makeChatArea();
require(path.join(__dirname, '..', 'public', 'client.js'));
const app = window.chatApp;
const state = app.state;
state.myClientId = 'me';
state.myNickname = '我';
state.currentRoom = 'main';

const micBtn = byId['micBtn'];
const voiceBar = byId['voiceBar'];
const voiceTime = byId['voiceTime'];
const voiceStopBtn = byId['voiceStopBtn'];
const voiceCancelBtn = byId['voiceCancelBtn'];
const chatArea = byId['chatArea'];

const click = (el, evt) => { const fns = (el._listeners && el._listeners[evt]) || []; fns.forEach((f) => f()); };

async function main() {
  voiceBar.hidden = true; // 模拟 index.html 上的 hidden 初始属性
  console.log('--- 录音 → 停止自动发送 ---');
  assert(voiceBar.hidden, '初始录音条隐藏');
  click(micBtn, 'click');
  await tick(); await tick();
  assert(FakeRecorder.instances.length === 1, '创建了 MediaRecorder 实例');
  assert(!voiceBar.hidden, '录音中显示录音条');
  assert(micBtn.classList.contains('recording'), '麦克风按钮进入录音态');
  assert(/:\d{2}/.test(voiceTime.textContent || ''), '计时器显示', voiceTime.textContent);

  click(voiceStopBtn, 'click');
  const sent = await waitUntil(() => calls.some((c) => c.url === '/upload/complete'));
  assert(sent, '停止后自动上传（complete 被调用）');
  const comp = calls.find((c) => c.url === '/upload/complete');
  const fd = comp.opts.body;
  assert(fd.get('audio') === '1', 'complete 携带 audio=1（归档到 audio/）', String(fd.get('audio')));
  const origName = decodeURIComponent(String(fd.get('originalName')));
  assert(origName.startsWith('语音消息-') && origName.endsWith('.webm'), '语音文件名 语音消息-*.webm', origName);
  assert(voiceBar.hidden, '发送后录音条收起');
  await waitUntil(() => byId['attachTray'].hidden === true);
  assert(byId['attachTray'].hidden === true, '上传完成托托盘清空');

  console.log('--- 语音消息气泡渲染（chat_message 带 audio） ---');
  socketHandlers['chat_message']({ ...completeBody });
  const lastMsg = chatArea.children[chatArea.children.length - 1];
  assert((lastMsg._html || '').includes('msg-audio'), '语音消息渲染内嵌 <audio> 播放器');
  assert((lastMsg._html || '').includes('语音消息'), '气泡标注语音消息', (lastMsg._html || '').slice(0, 80));

  console.log('--- 取消录音：不上传 ---');
  const initCallsBefore = calls.filter((c) => c.url === '/upload/init').length;
  click(micBtn, 'click');
  await tick(); await tick();
  assert(!voiceBar.hidden, '再次录音显示录音条');
  click(voiceCancelBtn, 'click');
  assert(voiceBar.hidden, '取消后录音条收起');
  assert(!micBtn.classList.contains('recording'), '取消后退出录音态');
  const initCallsAfter = calls.filter((c) => c.url === '/upload/init').length;
  assert(initCallsAfter === initCallsBefore, '取消录音未发起任何上传');

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
