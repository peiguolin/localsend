/* 机器人续聊窗口集成测试：
 * - @机器人 回复后，同一用户在窗口内不必再 @，直接发也触发
 * - 续聊每次回复刷新窗口
 * - 其他用户的普通消息不误触发；退出词结束续聊；超时自动结束
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3138;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-bot-followup.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let llmHits = 0;
function startLLM() {
  const srv = http.createServer((req, res) => {
    llmHits++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好的' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}
function startServer(port, env) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', () => {});
    setTimeout(() => reject(new Error('boot timeout')), 8000);
  });
}
function connect(cid) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId: cid } });
    s.once('welcome', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}
// 等到下一次机器人正式回复（bot_done），带超时
function nextBotDone(sock, ms = 6000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待机器人回复超时')), ms);
    const h = () => { clearTimeout(t); sock.off('bot_done', h); resolve(); };
    sock.on('bot_done', h);
  });
}

async function main() {
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  const llm = await startLLM();
  const proc = await startServer(PORT, {
    LOCALSEND_BOT_ENABLED: '1', LOCALSEND_BOT_NAME: '机器人',
    LOCALSEND_BOT_BASE_URL: `http://127.0.0.1:${llm.address().port}`,
    LOCALSEND_BOT_MODEL: 'm', LOCALSEND_BOT_FOLLOWUP_SEC: '3'
  });
  let me, other;
  try {
    me = await connect('cMe');
    other = await connect('cOther');
    await sleep(100);
    llmHits = 0;

    console.log('【首次 @机器人 → 触发并开启续聊】');
    llmHits = 0;
    const p1 = nextBotDone(me);
    // clientId 用连接自己的（服务端从 socket.data 取），这里发文本即可
    me.emit('chat_message', { text: '帮我写个排序 @机器人', clientId: 'cMe', room: 'main' });
    await p1;
    check('首次 @ 触发 LLM', llmHits === 1);

    console.log('【续聊：同一人不 @ 直接追问】');
    llmHits = 0;
    const p2 = nextBotDone(me);
    me.emit('chat_message', { text: '改成降序', clientId: 'cMe', room: 'main' });
    await p2;
    check('免 @ 追问触发', llmHits === 1);

    console.log('【其他人的普通消息不触发】');
    llmHits = 0;
    other.emit('chat_message', { text: '今天天气不错', clientId: 'cOther', room: 'main' });
    await sleep(600);
    check('非续聊对象不触发', llmHits === 0);

    console.log('【退出词结束续聊】');
    llmHits = 0;
    me.emit('chat_message', { text: '退出', clientId: 'cMe', room: 'main' });
    await sleep(300);
    me.emit('chat_message', { text: '在吗', clientId: 'cMe', room: 'main' });
    await sleep(600);
    check('退出后普通消息不再触发', llmHits === 0);

    console.log('【超时自动结束】');
    llmHits = 0;
    const p3 = nextBotDone(me);
    me.emit('chat_message', { text: '再来一个 @机器人', clientId: 'cMe', room: 'main' });
    await p3;
    check('再次 @ 触发', llmHits >= 1);
    await sleep(3400); // 超过 3s 窗口
    llmHits = 0;
    me.emit('chat_message', { text: '还在吗', clientId: 'cMe', room: 'main' });
    await sleep(600);
    check('窗口超时后不触发', llmHits === 0);
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { me && me.disconnect(); } catch (_) {}
    try { other && other.disconnect(); } catch (_) {}
    proc.kill();
    llm.close();
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
