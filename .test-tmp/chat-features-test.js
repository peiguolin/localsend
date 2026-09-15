/* 聊天增强集成测试：@提及解析/引用快照/撤回权限/文件消息撤回 + 前端资产静态校验 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3100;
const BASE = `https://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'] });
    s.on('welcome', (w) => resolve({ s, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function emitAck(sock, event, data) {
  return new Promise((resolve) => {
    if (data === undefined) sock.emit(event, resolve);
    else sock.emit(event, data, resolve);
  });
}

// 等待满足条件的 chat_message
function waitMsg(sock, pred, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待消息超时')), timeout);
    const h = (d) => {
      if (pred(d)) {
        clearTimeout(t);
        sock.off('chat_message', h);
        resolve(d);
      }
    };
    sock.on('chat_message', h);
  });
}

function waitEvent(sock, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

async function main() {
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: path.join(__dirname, "test-chat.db") },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  try {
    const { s: a, nickname: nickA } = await connectSocket();
    const { s: b, nickname: nickB } = await connectSocket();

    console.log('【@提及解析】');
    let p = waitMsg(b, (d) => d.text === `@${nickB} 看一下`);
    a.emit('chat_message', { text: `@${nickB} 看一下` });
    let m = await p;
    check('消息带唯一 ID', typeof m.id === 'string' && m.id.length > 4);
    check('@昵称 正确解析为提及', Array.isArray(m.mentions) && m.mentions.includes(nickB));

    p = waitMsg(a, (d) => d.text === `@${nickB}abc 在吗`);
    a.emit('chat_message', { text: `@${nickB}abc 在吗` });
    m = await p;
    check('昵称右侧非边界不计提及', m.mentions.length === 0);

    p = waitMsg(a, (d) => d.text === '邮箱 a@b.com 别误判');
    a.emit('chat_message', { text: '邮箱 a@b.com 别误判' });
    m = await p;
    check('邮箱不误判为提及', m.mentions.length === 0);

    console.log('【引用快照】');
    p = waitMsg(a, (d) => d.text === '原消息内容');
    a.emit('chat_message', { text: '原消息内容' });
    const m1 = await p;
    p = waitMsg(b, (d) => d.text === '回复你');
    b.emit('chat_message', { text: '回复你', quoteId: m1.id });
    m = await p;
    check('引用快照含作者与原文', m.quote && m.quote.nickname === nickA && m.quote.text === '原消息内容',
      JSON.stringify(m.quote));

    const longText = '长'.repeat(100);
    p = waitMsg(a, (d) => d.text === longText);
    a.emit('chat_message', { text: longText });
    const m2 = await p;
    p = waitMsg(b, (d) => d.text === '引用长文');
    b.emit('chat_message', { text: '引用长文', quoteId: m2.id });
    m = await p;
    check('长文引用截断到 80 字+省略号', m.quote && m.quote.text.length === 81 && m.quote.text.endsWith('…'),
      m.quote && String(m.quote.text.length));

    p = waitMsg(b, (d) => d.text === '引用不存在');
    b.emit('chat_message', { text: '引用不存在', quoteId: 'm999none' });
    m = await p;
    check('引用不存在消息时无 quote 字段', !m.quote);

    console.log('【撤回】');
    p = waitMsg(a, (d) => d.text === '发错了');
    a.emit('chat_message', { text: '发错了' });
    const m3 = await p;
    const r1 = await emitAck(b, 'chat_recall', { id: m3.id });
    check('撤回他人消息被拒', !r1.ok && r1.error.includes('自己的'), r1.error);
    const recallP = waitEvent(b, 'chat_recall');
    const r2 = await emitAck(a, 'chat_recall', { id: m3.id });
    check('撤回本人消息成功', r2.ok === true);
    const recall = await recallP;
    check('撤回广播全员', recall.id === m3.id && recall.nickname === nickA);
    const r3 = await emitAck(a, 'chat_recall', { id: m3.id });
    check('重复撤回被拒', !r3.ok);
    p = waitMsg(b, (d) => d.text === '引用已撤回');
    b.emit('chat_message', { text: '引用已撤回', quoteId: m3.id });
    m = await p;
    check('已撤回消息不可被引用', !m.quote);

    console.log('【文件消息撤回】');
    const form = new FormData();
    form.append('file', new Blob(['recall-test'], { type: 'text/plain' }), '撤回测试.txt');
    form.append('nickname', nickA);
    const upRes = await (await fetch(`${BASE}/upload`, { method: 'POST', body: form })).json();
    check('文件上传返回消息 ID', upRes.ok && typeof upRes.id === 'string');
    const r4 = await emitAck(a, 'chat_recall', { id: upRes.id });
    check('文件消息可撤回', r4.ok === true, r4.error);

    console.log('【前端资产】');
    const pub = path.join(__dirname, '..', 'public');
    const vendor = path.join(pub, 'vendor', 'highlight.min.js');
    check('highlight.js 已 vendor', fs.existsSync(vendor) && fs.statSync(vendor).size > 100000);
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    check('页面加载 highlight.js 与引用预览条', html.includes('vendor/highlight.min.js') && html.includes('id="quotePreview"'));
    // 撤回/代码复制在 chat 分片、@补全在 autocomplete 分片（client.js 为壳，负责装配各分片）
    const chat = fs.readFileSync(path.join(pub, 'client-parts', 'chat.js'), 'utf8');
    const ac = fs.readFileSync(path.join(pub, 'client-parts', 'autocomplete.js'), 'utf8');
    const shell = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
    check('chat 分片含撤回/代码复制逻辑',
      chat.includes('chat_recall') && chat.includes('code-copy'));
    check('autocomplete 分片含补全逻辑', ac.includes('ac-box'));
    check('client.js 装配了各功能分片',
      shell.includes("require('./client-parts/chat.js')") && shell.includes("require('./client-parts/autocomplete.js')"));

    a.disconnect(); b.disconnect();
  } finally {
    serverProc.kill();
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
