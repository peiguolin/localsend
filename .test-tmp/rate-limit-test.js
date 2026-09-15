/* 发言限流集成测试：窗口内超量拒绝；连续超量自动短禁言；禁言后发言被拒。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3140;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-ratelimit.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_MSG_RATE_LIMIT: '3', LOCALSEND_MSG_RATE_WINDOW_SEC: '5'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

function connectSocket(clientId) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false, auth: { clientId } });
    s.once('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {} }

  console.log('【发言限流：窗口内超量拒绝】');
  const proc = await startServer(PORT);
  let A, B;
  try {
    A = await connectSocket('cA');
    B = await connectSocket('cB');
    await sleep(200);

    // B 统计收到的 chat_message；A 记录收到的系统消息
    let bcCount = 0;
    const bMsgH = () => { bcCount++; };
    B.s.on('chat_message', bMsgH);
    const aSys = [];
    A.s.on('system_message', (m) => aSys.push((m && m.text) || ''));

    // A 连发 6 条（limit=3）：前 3 条放行，第 4/5 条"太频繁"，第 6 条触发自动禁言
    for (let i = 1; i <= 6; i++) {
      A.s.emit('chat_message', { text: `刷屏 ${i}`, room: 'main', clientId: 'cA' });
    }
    await sleep(600);
    check('窗口内只放行 3 条（observer 收到 3 条）', bcCount === 3, `实得 ${bcCount}`);
    check('A 收到"发送太频繁"提示', aSys.some((t) => /太频繁/.test(t)));
    check('A 收到自动禁言提示（连续超量）', aSys.some((t) => /临时禁言/.test(t)));

    // 已自动禁言：再发 → 被"你已被禁言"拦截
    A.s.emit('chat_message', { text: '还被禁言吗', room: 'main', clientId: 'cA' });
    await sleep(400);
    check('禁言后发言被"你已被禁言"拦截', aSys.some((t) => /你已被禁言/.test(t)));
    check('禁言后消息未广播给 observer', bcCount === 3, `实得 ${bcCount}`);
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { A && A.s.disconnect(); } catch (_) {}
    try { B && B.s.disconnect(); } catch (_) {}
    proc.kill();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {} }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
