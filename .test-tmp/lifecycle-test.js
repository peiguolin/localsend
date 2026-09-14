/* 数据生命周期集成测试：撤回删文件 / 文件 TTL / 容量 LRU / 孤儿文件 / .tmp 碎片 / 消息保留 / 权限 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { io } = require('socket.io-client');

const PORT = 3100;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-lifecycle.db');
const UP_DIR = path.join(__dirname, 'test-uploads');
const DAY = 24 * 60 * 60 * 1000;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = typeof net.family === 'string' ? net.family : `IPv${net.family}`;
      if (family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function connectSocket(host, clientId = 'client-lc') {
  return new Promise((resolve, reject) => {
    const s = io(`https://${host}:${PORT}`, {
      rejectUnauthorized: false, transports: ['websocket'], auth: { clientId }
    });
    s.on('welcome', () => resolve(s));
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

function loadMetaFile() {
  return JSON.parse(fs.readFileSync(path.join(UP_DIR, '.meta.json'), 'utf8'));
}

function saveMetaFile(db) {
  fs.writeFileSync(path.join(UP_DIR, '.meta.json'), JSON.stringify(db, null, 2));
}

// 在 uploads 里按 storedName 找文件实际路径（递归）
function findStoredFile(storedName) {
  let found = null;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === storedName) found = p;
    }
  })(UP_DIR);
  return found;
}

async function uploadFile(sock, nickname, fileName, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), fileName);
  form.append('nickname', nickname);
  form.append('clientId', 'client-lc');
  const res = await (await fetch(`${BASE}/upload`, { method: 'POST', body: form })).json();
  if (!res.ok) throw new Error('上传失败: ' + JSON.stringify(res));
  return res; // { id, storedName, ... }
}

async function sweep(sock) {
  const r = await emitAck(sock, 'lifecycle_sweep');
  if (!r.ok) throw new Error('sweep 被拒: ' + r.error);
  return r.report;
}

async function main() {
  // 干净的测试环境
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
  fs.rmSync(UP_DIR, { recursive: true, force: true });

  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_UPLOAD_DIR: UP_DIR,
      LOCALSEND_LOCAL_ADDRS: '127.0.0.1,::1,::ffff:127.0.0.1',
      LOCALSEND_FILE_TTL_DAYS: '30',
      LOCALSEND_MAX_UPLOAD_MB: '0.004', // 4KB，便于触发 LRU
      LOCALSEND_MSG_TTL_DAYS: '7'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  try {
    const local = await connectSocket('127.0.0.1');
    const nick = '生命周期测试员';

    console.log('【撤回删文件本体】');
    const up1 = await uploadFile(local, nick, '撤回删除.txt', 'x'.repeat(100));
    check('文件已落盘', !!findStoredFile(up1.storedName));
    const rc = await emitAck(local, 'chat_recall', { id: up1.id, clientId: 'client-lc' });
    check('撤回成功', rc.ok === true);
    check('撤回后文件本体已删除', !findStoredFile(up1.storedName));
    check('撤回后元数据已删除', !(up1.storedName in loadMetaFile()));

    console.log('【文件 TTL】');
    const upA = await uploadFile(local, nick, '过期文件.txt', 'a'.repeat(100));
    const upB = await uploadFile(local, nick, '新鲜文件.txt', 'b'.repeat(100));
    // 把 A 的 uploadedAt 回拨 40 天
    const meta1 = loadMetaFile();
    meta1[upA.storedName].uploadedAt = Date.now() - 40 * DAY;
    saveMetaFile(meta1);
    const rep1 = await sweep(local);
    check('TTL 删除过期文件', rep1.files.ttlDeleted >= 1, JSON.stringify(rep1.files));
    check('过期文件已删除', !findStoredFile(upA.storedName));
    check('新鲜文件保留', !!findStoredFile(upB.storedName));

    console.log('【容量上限 LRU】');
    const upC = await uploadFile(local, nick, '较大C.txt', 'c'.repeat(3000));
    await new Promise((r) => setTimeout(r, 20));
    const upD = await uploadFile(local, nick, '较大D.txt', 'd'.repeat(3000));
    // 当前总量 ≈ 100(B) + 3000(C) + 3000(D) > 4KB → 从最旧(B, C)开始淘汰
    const rep2 = await sweep(local);
    check('LRU 淘汰最旧文件', rep2.files.lruDeleted >= 1, JSON.stringify(rep2.files));
    check('最旧的 B 被淘汰', !findStoredFile(upB.storedName));
    check('最新的 D 保留', !!findStoredFile(upD.storedName));

    console.log('【孤儿文件】');
    const orphanName = '1999999999999-abcdef123456.txt';
    const orphanPath = path.join(UP_DIR, orphanName);
    fs.writeFileSync(orphanPath, 'orphan');
    let rep3 = await sweep(local);
    check('新孤儿文件不删（防误删上传中）', fs.existsSync(orphanPath) && rep3.files.orphansDeleted === 0);
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(orphanPath, old / 1000, old / 1000);
    rep3 = await sweep(local);
    check('超龄孤儿文件被清理', !fs.existsSync(orphanPath) && rep3.files.orphansDeleted >= 1, JSON.stringify(rep3.files));

    console.log('【.tmp 碎片】');
    const staleTmp = path.join(UP_DIR, '.tmp', 'deadbeefdeadbeefdeadbeefdeadbeef');
    fs.mkdirSync(staleTmp, { recursive: true });
    fs.writeFileSync(path.join(staleTmp, '0.part'), 'x');
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(staleTmp, stale / 1000, stale / 1000);
    const rep4 = await sweep(local);
    check('过期 .tmp 碎片被清理', !fs.existsSync(staleTmp) && rep4.files.tmpDirsDeleted >= 1, JSON.stringify(rep4.files));

    console.log('【消息保留策略】');
    const mp = new Promise((resolve) => local.once('chat_message', resolve));
    local.emit('chat_message', { text: '一条老消息', clientId: 'client-lc' });
    const sentMsg = await mp;
    // 回拨消息时间到 8 天前（直接改库；WAL 模式允许多进程写）
    const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
    const tdb = new Database(DB_FILE);
    tdb.prepare('UPDATE messages SET timestamp = ? WHERE msg_id = ?').run(Date.now() - 8 * DAY, sentMsg.id);
    tdb.close();
    const rep5 = await sweep(local);
    check('过期消息被清理', rep5.messages.messages >= 1, JSON.stringify(rep5.messages));
    const hist = await emitAck(local, 'room_history', { room: 'main' });
    check('清理后历史无该消息', !hist.history.some((m) => m.id === sentMsg.id));

    console.log('【统计与权限】');
    const stats = await emitAck(local, 'history_stats');
    check('统计含磁盘占用', stats.ok && stats.disk && typeof stats.disk.bytes === 'number');
    check('统计含保留策略', stats.retention && stats.retention.fileTtlDays === 30 && stats.retention.msgTtlDays === 7);
    const lanIP = getLanIP();
    if (lanIP) {
      const remote = await connectSocket(lanIP, 'client-remote');
      const denied = await emitAck(remote, 'lifecycle_sweep');
      check('非宿主机清扫被拒', !denied.ok && denied.error.includes('仅宿主机'), denied.error);
      remote.disconnect();
    } else {
      console.log('  ⊘ 无局域网 IP，跳过远程拒绝测试');
    }

    // 恢复脚本静态校验
    const restoreScript = path.join(__dirname, '..', 'scripts', 'restore-db.js');
    check('恢复脚本存在', fs.existsSync(restoreScript));

    local.disconnect();
  } finally {
    serverProc.kill();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }
    fs.rmSync(UP_DIR, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
