/* 房间级机器人覆盖集成测试。
 * P1（默认 localAddrs=回环=宿主机）：关闭 main 房机器人不触发 / 开启+自定义提示词生效。
 * P2（localAddrs 受限）：非宿主机改 main 房被拒；房主（非宿主机）可设置自己的群聊房。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3160, PORT2 = 3161;
const BASE = `https://127.0.0.1:${PORT}`;
const BASE2 = `https://127.0.0.1:${PORT2}`;
const DB_FILE = path.join(__dirname, 'test-roombot.db');
const DB_FILE2 = path.join(__dirname, 'test-roombot2.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let llmReq = null;
function startLLM() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        llmReq = JSON.parse(body || '{}');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '房间机器人回复。' } }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startServer(port, dbFile, llmPort, extraEnv) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(port), LOCALSEND_DB_FILE: dbFile,
      LOCALSEND_BOT_ENABLED: '1', LOCALSEND_BOT_BASE_URL: `http://127.0.0.1:${llmPort}`,
      LOCALSEND_BOT_NAME: '机器人', LOCALSEND_BOT_PROMPT: '全局提示词', LOCALSEND_MSG_RATE_LIMIT: '0',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

function connectSocket(base, clientId) {
  return new Promise((resolve, reject) => {
    const s = io(base, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId } });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}
const emitAck = (sock, evt, data) => new Promise((resolve) => sock.emit(evt, data, resolve));

async function expectNoBotReply(sock, ms = 700) {
  let got = false;
  const h = (m) => { if (m && m.isBot) got = true; };
  sock.on('chat_message', h);
  await sleep(ms);
  sock.off('chat_message', h);
  return !got;
}

async function main() {
  for (const db of [DB_FILE, DB_FILE2]) for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(db + suffix); } catch (_) {} }
  const llm = await startLLM();

  console.log('【P1 功能：关闭 / 开启+房间提示词】');
  const proc1 = await startServer(PORT, DB_FILE, llm.address().port, {});
  let host, A, proc2;
  try {
    host = await connectSocket(BASE, 'host-cid'); // 127.0.0.1 → 宿主机
    A = await connectSocket(BASE, 'cA');

    const get0 = await emitAck(host.s, 'room_bot_config', { room: 'main', get: true });
    check('默认覆盖为继承全局（enabled=null）', get0.ok && get0.enabled === null);

    const off = await emitAck(host.s, 'room_bot_config', { room: 'main', enabled: false, prompt: '' });
    check('宿主机可关闭 main 房机器人', off.ok && off.enabled === false);
    llmReq = null;
    A.s.emit('chat_message', { text: '@机器人 在吗', room: 'main', clientId: 'cA' });
    const quiet = await expectNoBotReply(A.s);
    check('关闭后 @机器人 不触发', quiet);
    check('假 LLM 未被调用', llmReq === null);

    const on = await emitAck(host.s, 'room_bot_config', { room: 'main', enabled: true, prompt: '房间专属提示词' });
    check('宿主机开启 main 房机器人并设提示词', on.ok && on.enabled === true && on.prompt === '房间专属提示词');
    const got = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('等待机器人回复超时')), 6000);
      const h = (m) => { if (m && m.isBot) { clearTimeout(t); A.s.off('chat_message', h); resolve(m); } };
      A.s.on('chat_message', h);
      A.s.emit('chat_message', { text: '@机器人 在吗', room: 'main', clientId: 'cA' });
    });
    check('开启后 @机器人 回复', got && got.isBot);
    check('使用了房间提示词而非全局', llmReq.messages[0].content.includes('房间专属提示词'));
    check('未使用全局提示词', !llmReq.messages[0].content.includes('全局提示词'));
  } catch (e) {
    check('P1 流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { host && host.s.disconnect(); } catch (_) {}
    try { A && A.s.disconnect(); } catch (_) {}
    proc1.kill();
    await sleep(300);
  }

  console.log('【P2 权限：非宿主机拒绝 / 房主可设】');
  proc2 = await startServer(PORT2, DB_FILE2, llm.address().port, { LOCALSEND_LOCAL_ADDRS: '192.0.2.99' });
  let X, Y;
  try {
    X = await connectSocket(BASE2, 'cX'); // 非本机 → 非宿主机
    Y = await connectSocket(BASE2, 'cY');

    const deny = await emitAck(X.s, 'room_bot_config', { room: 'main', enabled: false });
    check('非宿主机改 main 房被拒', !deny.ok, JSON.stringify(deny));

    // X 创建群聊（X 为房主），可设置该房
    const createdP = new Promise((resolve) => X.s.once('group_created', resolve));
    const createRes = await emitAck(X.s, 'group_create', { targetIds: [Y.id] });
    const gid = createRes && createRes.room && createRes.room.id;
    check('X 创建的群聊房有 id', !!gid, JSON.stringify(createRes));
    if (gid) {
      const ownerSet = await emitAck(X.s, 'room_bot_config', { room: gid, enabled: true });
      check('房主（非宿主机）可设置自己房间的机器人', ownerSet.ok && ownerSet.enabled === true, JSON.stringify(ownerSet));
      const ownerDeny = await emitAck(Y.s, 'room_bot_config', { room: gid, enabled: false });
      check('非房主成员改该房被拒', !ownerDeny.ok, JSON.stringify(ownerDeny));
    }
    void createdP;
  } catch (e) {
    check('P2 流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { X && X.s.disconnect(); } catch (_) {}
    try { Y && Y.s.disconnect(); } catch (_) {}
    proc2.kill();
    llm.close();
    for (const db of [DB_FILE, DB_FILE2]) for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(db + suffix); } catch (_) {} }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
