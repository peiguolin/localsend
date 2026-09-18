/* AI 机器人集成测试：OpenAI 兼容接口接入。
 * 用内置假 LLM 端点验证：@提及触发、回复 isBot 入库广播、上下文/鉴权/模型透传、
 * 成员列表注入机器人、/api/config 掩码 apiKey、无@不触发。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3110;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-bot.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 假 OpenAI 兼容 LLM 端点 ----------
let llmReq = null;
function sse(data) { return `data: ${JSON.stringify(data)}\n\n`; }
function startLLM() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        llmReq = { url: req.url, method: req.method, auth: req.headers.authorization || '', body: JSON.parse(body || '{}') };
        if (llmReq.body.stream) {
          // 流式：逐块 SSE，再发 [DONE]
          res.setHeader('Content-Type', 'text/event-stream');
          res.write(sse({ choices: [{ delta: { role: 'assistant' } }] }));
          res.write(sse({ choices: [{ delta: { content: '我是机器人' } }] }));
          res.write(sse({ choices: [{ delta: { content: '，收到。' } }] }));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '我是机器人，收到。' } }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startServer(port, extraEnv) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error(`服务器(${port})启动超时`)), 8000);
  });
}

function connectSocket(clientId) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], auth: { clientId } });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function waitBotReply(sock, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待机器人回复超时')), timeout);
    const h = (m) => {
      if (m && m.isBot) { clearTimeout(t); sock.off('chat_message', h); resolve(m); }
    };
    sock.on('chat_message', h);
  });
}

function waitBotMember(sock, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('成员列表未出现机器人')), timeout);
    const h = (members) => {
      if (Array.isArray(members) && members.some((m) => m && m.bot && m.nickname === '机器人')) {
        clearTimeout(t); sock.off('members_update', h); resolve(true);
      }
    };
    sock.on('members_update', h);
  });
}

async function expectNoBotReply(sock, ms = 700) {
  let got = false;
  const h = (m) => { if (m && m.isBot) got = true; };
  sock.on('chat_message', h);
  await sleep(ms);
  sock.off('chat_message', h);
  return !got;
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
  const llm = await startLLM();
  const llmPort = llm.address().port;

  console.log('【机器人 @提及 全流程】');
  const proc = await startServer(PORT, {
    LOCALSEND_BOT_ENABLED: '1',
    LOCALSEND_BOT_BASE_URL: `http://127.0.0.1:${llmPort}`,
    LOCALSEND_BOT_API_KEY: 'test-secret',
    LOCALSEND_BOT_MODEL: 'test-model',
    LOCALSEND_BOT_NAME: '机器人'
  });

  let A, B;
  try {
    // /api/config 掩码 apiKey（宿主机访问）
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    check('GET /api/config 返回 botEnabled=true', cfg.ok && cfg.config.botEnabled === true);
    check('GET /api/config 掩码 botApiKey（不回显真实 key）', cfg.ok && cfg.config.botApiKey === '');

    A = await connectSocket('cA');
    B = await connectSocket('cB');
    await waitBotMember(B.s);
    check('成员列表含机器人（@自动补全数据源）', true);

    // 触发：@机器人（同时收集流式事件）
    const stream = { start: null, deltas: [], done: null };
    B.s.on('bot_start', (d) => { stream.start = d; });
    B.s.on('bot_delta', (d) => { stream.deltas.push(d); });
    B.s.on('bot_done', (d) => { stream.done = d; });
    const replyP = waitBotReply(B.s);
    B.s.emit('chat_message', { text: '你好 @机器人', room: 'main', clientId: 'cB' });
    const reply = await replyP;
    check('收到机器人回复（isBot + 昵称「机器人」）', reply.isBot === true && reply.nickname === '机器人');
    check('回复文本来自 LLM', reply.text === '我是机器人，收到。');
    check('回复带 room', reply.room === 'main');
    check('机器人消息 clientId 以 bot: 开头', String(reply.clientId).indexOf('bot:') === 0);

    // 流式事件
    check('收到 bot_start（临时气泡）', stream.start && stream.start.tempId && stream.start.nickname === '机器人');
    check('收到 2 个 bot_delta 且拼接正确',
      stream.deltas.length === 2 &&
      stream.deltas.map((d) => d.piece).join('') === '我是机器人，收到。' &&
      stream.deltas[stream.deltas.length - 1].full === '我是机器人，收到。');
    check('收到 bot_done 且带正式消息 id', stream.done && stream.done.tempId === stream.start.tempId && !!stream.done.id);

    // 假 LLM 收到的请求体
    check('调用 /v1/chat/completions', llmReq && llmReq.url === '/v1/chat/completions' && llmReq.method === 'POST');
    check('请求带 stream:true（流式）', llmReq.body.stream === true);
    check('Authorization Bearer 透传', llmReq.auth === 'Bearer test-secret');
    check('model 透传', llmReq.body.model === 'test-model');
    check('messages 首条为 system', llmReq.body.messages[0].role === 'system');
    const last = llmReq.body.messages[llmReq.body.messages.length - 1];
    check('末条 user 含 @机器人 原文', last.role === 'user' && last.content.includes('你好 @机器人'));

    // 无 @ 不触发：B 刚 @ 过处于续聊窗口，改用未在续聊的 A 发普通消息。
    // 以"假 LLM 是否被再次调用"为唯一判据（监听 bot_start，比 chat_message 更准，
    // 不会被上一条机器人回复的迟到广播干扰）。
    llmReq = null;
    let started = false;
    const onStart = () => { started = true; };
    A.s.on('bot_start', onStart);
    A.s.emit('chat_message', { text: '这是普通消息', room: 'main', clientId: 'cA' });
    await sleep(700);
    A.s.off('bot_start', onStart);
    check('无 @提及 不触发机器人（非续聊用户）', !started);
    check('假 LLM 未被再次调用', llmReq === null);
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { A && A.s.disconnect(); } catch (_) {}
    try { B && B.s.disconnect(); } catch (_) {}
    proc.kill();
    llm.close();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
