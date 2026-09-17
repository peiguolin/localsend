/* 机器人看图（视觉多模态）集成测试：
 * - 开启 botVision 后，图片配文 @机器人 → 请求体末条 user.content 含 image_url（data: base64）
 * - 关闭 botVision 时，同样的图片配文不触发 LLM
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3136;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-bot-vision.db');
// 1×1 PNG（真实 PNG 头，过魔数校验）
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000200000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startLLM() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      calls.push(parsed);
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '看到了，是一张图片。' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, calls })));
}

function startServer(port, env) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}
function connectSocket(cid) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId: cid } });
    s.once('welcome', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}
async function uploadImage(clientId, caption) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'pic.png');
  fd.append('nickname', '上传者');
  fd.append('clientId', clientId);
  fd.append('room', 'main');
  if (caption) fd.append('text', caption);
  const r = await fetch(`${BASE}/upload`, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function waitBotDone(sock, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待 bot_done 超时')), ms);
    const h = (d) => { clearTimeout(t); sock.off('bot_done', h); resolve(d); };
    sock.on('bot_done', h);
  });
}

async function main() {
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  const llm = await startLLM();
  const proc = await startServer(PORT, {
    LOCALSEND_BOT_ENABLED: '1', LOCALSEND_BOT_NAME: '机器人',
    LOCALSEND_BOT_BASE_URL: `http://127.0.0.1:${llm.srv.address().port}`,
    LOCALSEND_BOT_MODEL: 'vision-model', LOCALSEND_BOT_VISION: '1'
  });
  let sock;
  try {
    sock = await connectSocket('cVis');
    await sleep(100); // 等成员/机器人广播

    console.log('【视觉开启：图片配文 @机器人 → 多模态请求】');
    llm.calls.length = 0;
    const doneP = waitBotDone(sock);
    const res = await uploadImage('cVis', '这是什么 @机器人');
    check('图片上传成功', res.status === 200 && res.body && res.body.type === 'image');
    await doneP;
    await sleep(50);
    check('LLM 被调用 1 次', llm.calls.length === 1, String(llm.calls.length));
    const lastMsg = llm.calls[0] && llm.calls[0].messages && llm.calls[0].messages[llm.calls[0].messages.length - 1];
    const content = lastMsg && lastMsg.content;
    check('末条 content 为多模态数组', Array.isArray(content));
    const textPart = Array.isArray(content) && content.find((p) => p.type === 'text');
    const imgPart = Array.isArray(content) && content.find((p) => p.type === 'image_url');
    check('含文字部分', !!(textPart && textPart.text.includes('这是什么')));
    check('含 image_url 且为 data:image base64', !!(imgPart && /^data:image\/png;base64,/.test(imgPart.image_url && imgPart.image_url.url || '')));

    // 反向：无 @机器人 的图片配文不触发
    llm.calls.length = 0;
    await uploadImage('cVis', '随手发张图');
    await sleep(500);
    check('无 @机器人 的图片不触发', llm.calls.length === 0, String(llm.calls.length));
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { sock && sock.disconnect(); } catch (_) {}
    proc.kill();
    llm.srv.close();
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
