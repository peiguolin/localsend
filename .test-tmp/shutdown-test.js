/* 优雅退出 集成测试：
 * - 发送 SIGTERM → 服务器打印优雅退出日志、正常退出码 0（10 秒内）
 * - 退出前广播系统消息"服务器正在关闭"
 * - 退出后 SQLite 数据库文件存在且可正常打开（WAL 已 checkpoint）
 * - 重启后历史消息仍可读（持久化未被破坏）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { io } = require('socket.io-client');

const PORT = 3146;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-shutdown.db');
const UPLOAD_DIR = path.join(__dirname, 'shutdown-uploads');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'], reconnection: false });
    s.on('welcome', (w) => resolve({ s, w }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function startServer() {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_UPLOAD_DIR: UPLOAD_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    let logs = '';
    proc.stdout.on('data', (d) => { logs += String(d); if (String(d).includes('已启动')) resolve({ proc, logs: () => logs }); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

const waitEvent = (s, event, filter, timeoutMs) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { s.off(event, h); reject(new Error(`等不到 ${event}`)); }, timeoutMs || 5000);
  const h = (d) => { if (!filter || filter(d)) { clearTimeout(t); s.off(event, h); resolve(d); } };
  s.on(event, h);
});

async function main() {
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}

  const { proc, logs } = await startServer();
  let c;
  try {
    // 发一条消息落库，供重启后验证
    c = await connectSocket();
    const shutdownMsg = waitEvent(c.s, 'system_message', (d) => d && /服务器正在关闭/.test(d.text || ''));
    c.s.emit('chat_message', { text: '退出前的一条历史消息', room: 'main', clientId: 'shutdown-c' });
    await new Promise((r) => setTimeout(r, 300));

    const t0 = Date.now();
    proc.kill('SIGTERM');
    const code = await new Promise((resolve) => proc.on('exit', resolve));
    const elapsed = Date.now() - t0;
    check('收到关闭系统消息', (await shutdownMsg.catch(() => null)) != null);
    check('进程正常退出（退出码 0）', code === 0, `code=${code}`);
    check('退出码 0 在 10 秒内完成', elapsed < 10000, `${elapsed}ms`);
    check('日志包含优雅退出提示', /优雅退出|正在关闭/.test(logs()), logs().slice(-300));

    // DB 文件完好（WAL 已 checkpoint：主文件存在且无 -wal 残留或可安全打开）
    check('主 DB 文件存在', fs.existsSync(DB_FILE));
    const db = new DatabaseSync(DB_FILE);
    const row = db.prepare("SELECT COUNT(*) AS n FROM messages").get();
    check('DB 可打开且消息表可读', typeof row === 'object' && row && Number(row.n) >= 1, JSON.stringify(row));
    db.close();

    console.log('【重启后历史仍可读】');
    const proc2 = await startServer();
    try {
      const c2 = await connectSocket();
      const hist = await new Promise((resolve) => c2.s.emit('room_history', { room: 'main' }, resolve));
      check('重启后 room_history 含退出前消息',
        hist && hist.ok && hist.history.some((m) => m.text === '退出前的一条历史消息'), JSON.stringify(hist && hist.history.slice(0, 3)));
      c2.s.disconnect();
    } finally {
      proc2.proc.kill();
    }
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
    try { proc.kill(); } catch (_) {}
  } finally {
    try { c && c.s.disconnect(); } catch (_) {}
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
    try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
