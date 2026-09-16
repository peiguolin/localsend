/* 共享下载断点续传（Range）集成测试：
 * - 无 Range 头 → 200 整文件 + Accept-Ranges: bytes
 * - bytes=start-end → 206 + 正确切片 + Content-Range: bytes start-end/total
 * - bytes=start-（开放区间）→ 206 从 start 到结尾
 * - bytes=-suffix（后缀区间）→ 206 最后 N 字节
 * - start >= 文件大小 → 416 + Content-Range: bytes *斜杠 total
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { io } = require('socket.io-client');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = 3145;
const BASE = `https://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, 'range-share-root');
const DB_FILE = path.join(__dirname, 'test-range.db');
const UPLOAD_DIR = path.join(__dirname, 'range-uploads');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function safeJoin(root, rel) {
  const p = path.resolve(root, rel || '');
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'] });
    s.on('welcome', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

const emitAck = (sock, event, data) => new Promise((resolve) => sock.emit(event, data, resolve));

// 共享者浏览器侧本地代理（支持 Range 切片，与 public/share.js localRead 同语义）
function attachOwnerAgent(sock, getShare) {
  sock.on('share_fs', async (req, reply) => {
    const share = getShare();
    if (!share) return reply({ ok: false, error: '无共享' });
    try {
      if (req.op === 'list') {
        const dir = safeJoin(ROOT, req.path);
        if (!dir || !fs.existsSync(dir)) return reply({ ok: false, error: '路径不存在' });
        const ents = fs.readdirSync(dir).map((name) => {
          const st = fs.statSync(path.join(dir, name));
          return st.isDirectory() ? { name, kind: 'dir' } : { name, kind: 'file', size: st.size, mtime: st.mtimeMs };
        });
        reply({ ok: true, entries: ents });
      } else if (req.op === 'read') {
        const fp = safeJoin(ROOT, req.path);
        if (!fp || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return reply({ ok: false, error: '文件不存在' });
        const buf = fs.readFileSync(fp);
        let sliceStart = 0;
        let sliceEnd = buf.length; // exclusive
        let hasRange = false;
        if (req.range) {
          hasRange = true;
          // bytes=-N：最后 N 字节（start 缺省）→ 归一化为绝对 start..end
          let rs = req.range.start;
          let re = req.range.end;
          if (rs === null && re !== null) {
            rs = Math.max(0, buf.length - re);
            re = null;
          }
          rs = rs == null ? 0 : rs;
          if (rs >= buf.length) return reply({ ok: false, rangeError: true, size: buf.length, error: '超出文件范围' });
          sliceStart = rs;
          sliceEnd = re == null ? buf.length : Math.min(re + 1, buf.length);
        }
        reply({ ok: true, size: buf.length });
        const url = `${BASE}/api/share/${share.id}/push?transferId=${req.transferId}` +
          `&token=${share.token}&name=${encodeURIComponent(path.basename(fp))}&size=${sliceEnd - sliceStart}` +
          (hasRange ? `&start=${sliceStart}&total=${buf.length}` : '');
        await fetch(url, {
          method: 'POST',
          body: fs.createReadStream(fp, { start: sliceStart, end: sliceEnd - 1 }),
          duplex: 'half',
          headers: { 'Content-Length': String(sliceEnd - sliceStart) }
        });
      } else if (req.op === 'write') {
        let fp = safeJoin(ROOT, req.path);
        if (!fp) return reply({ ok: false, error: '路径无效' });
        const resp = await fetch(`${BASE}/api/share/${share.id}/pull?transferId=${req.transferId}&token=${share.token}`);
        if (!resp.ok || !resp.body) return reply({ ok: false, error: '拉流失败' });
        await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(fp));
        reply({ ok: true });
      } else {
        reply({ ok: false, error: '未知操作' });
      }
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

async function main() {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  const content = crypto.randomBytes(1024 * 64); // 64KB
  fs.writeFileSync(path.join(ROOT, 'docs', '大文件.bin'), content);

  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_UPLOAD_DIR: UPLOAD_DIR, LOCALSEND_LOCAL_ADDRS: '10.255.255.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  let owner, guest;
  try {
    console.log('step: connect owner');
    owner = await connectSocket();
    console.log('step: connect guest');
    guest = await connectSocket();
    const shareState = { id: null, ownerToken: null, guestToken: null };
    attachOwnerAgent(owner, () => shareState.id && shareState.ownerToken ? { id: shareState.id, token: shareState.ownerToken } : null);

    console.log('step: share_register');
    const reg = await emitAck(owner, 'share_register', { name: 'range测试共享', writable: false });
    check('共享注册成功', reg && reg.ok, JSON.stringify(reg));
    shareState.id = reg.shareId;
    shareState.ownerToken = reg.token;
    console.log('step: share_enter');
    const enter = await emitAck(guest, 'share_enter', { shareId: reg.shareId });
    check('访问者进入共享', enter && enter.ok, JSON.stringify(enter));
    shareState.guestToken = enter.token;

    const fileUrl = (p) => `${BASE}/api/share/${shareState.id}/file?path=${encodeURIComponent(p)}&token=${shareState.guestToken}`;

    console.log('【整文件下载（无 Range）】');
    const full = await fetch(fileUrl('docs/大文件.bin'));
    const fullBuf = Buffer.from(await full.arrayBuffer());
    check('无 Range → 200', full.status === 200, `status=${full.status}`);
    check('Accept-Ranges: bytes', (full.headers.get('accept-ranges') || '').toLowerCase() === 'bytes', full.headers.get('accept-ranges'));
    check('整文件内容一致', fullBuf.equals(content), `len=${fullBuf.length}`);
    check('无 Range 不带 206/Content-Range', full.status !== 206 && !full.headers.get('content-range'));

    console.log('【bytes=1000-2999 分段】');
    const r1 = await fetch(fileUrl('docs/大文件.bin'), { headers: { Range: 'bytes=1000-2999' } });
    const b1 = Buffer.from(await r1.arrayBuffer());
    check('206 状态码', r1.status === 206, `status=${r1.status}`);
    check('Content-Range 正确', r1.headers.get('content-range') === `bytes 1000-2999/${content.length}`, r1.headers.get('content-range'));
    check('切片内容一致', b1.equals(content.slice(1000, 3000)), `len=${b1.length}`);
    check('Content-Length = 2000', Number(r1.headers.get('content-length')) === 2000, r1.headers.get('content-length'));

    console.log('【bytes=1000- 开放区间】');
    const r2 = await fetch(fileUrl('docs/大文件.bin'), { headers: { Range: 'bytes=1000-' } });
    const b2 = Buffer.from(await r2.arrayBuffer());
    check('206 状态码', r2.status === 206, `status=${r2.status}`);
    check('从 1000 到结尾', b2.equals(content.slice(1000)), `len=${b2.length}`);
    check('Content-Range 结尾正确', r2.headers.get('content-range') === `bytes 1000-${content.length - 1}/${content.length}`, r2.headers.get('content-range'));

    console.log('【bytes=-500 后缀区间（最后 500 字节）】');
    const r3 = await fetch(fileUrl('docs/大文件.bin'), { headers: { Range: 'bytes=-500' } });
    const b3 = Buffer.from(await r3.arrayBuffer());
    check('206 状态码', r3.status === 206, `status=${r3.status}`);
    check('最后 500 字节', b3.equals(content.slice(content.length - 500)), `len=${b3.length}`);

    console.log('【start 超界 → 416】');
    const r4 = await fetch(fileUrl('docs/大文件.bin'), { headers: { Range: `bytes=${content.length + 100}-` } });
    check('416 状态码', r4.status === 416, `status=${r4.status}`);
    check('416 带可恢复大小', r4.headers.get('content-range') === `bytes */${content.length}`, r4.headers.get('content-range'));

    // 多个 Range 连续请求（模拟断点续传多段拉取）也能正常叠加
    console.log('【多次分段拉取完整性】');
    let reassembled = Buffer.alloc(0);
    for (const [s, e] of [[0, 999], [1000, 1999], [2000, content.length - 1]]) {
      const r = await fetch(fileUrl('docs/大文件.bin'), { headers: { Range: `bytes=${s}-${e}` } });
      reassembled = Buffer.concat([reassembled, Buffer.from(await r.arrayBuffer())]);
    }
    check('分段拉取拼回与原文一致', reassembled.equals(content), `len=${reassembled.length}`);
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { owner && owner.disconnect(); } catch (_) {}
    try { guest && guest.disconnect(); } catch (_) {}
    proc.kill();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
    try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
