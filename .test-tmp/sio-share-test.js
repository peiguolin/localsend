/* 文件夹共享端到端集成测试：
 * 模拟共享者浏览器（socket.io-client 响应 share_fs 的 list/read/write），
 * 模拟访问者（HTTP 走服务器中转），验证浏览/下载/写入/鉴权/路径穿越防护。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { io } = require('socket.io-client');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = 3100;
const BASE = `https://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, 'share-root');

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

function emitAck(sock, event, data) {
  return new Promise((resolve) => sock.emit(event, data, resolve));
}

// 模拟共享者浏览器侧的本地代理
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
          return st.isDirectory()
            ? { name, kind: 'dir' }
            : { name, kind: 'file', size: st.size, mtime: st.mtimeMs };
        });
        reply({ ok: true, entries: ents });
      } else if (req.op === 'read') {
        const fp = safeJoin(ROOT, req.path);
        if (!fp || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
          return reply({ ok: false, error: '文件不存在' });
        }
        const size = fs.statSync(fp).size;
        reply({ ok: true });
        const url = `${BASE}/api/share/${share.id}/push?transferId=${req.transferId}` +
          `&token=${share.token}&name=${encodeURIComponent(path.basename(fp))}&size=${size}`;
        await fetch(url, {
          method: 'POST', body: fs.createReadStream(fp), duplex: 'half',
          headers: { 'Content-Length': String(size) }
        });
      } else if (req.op === 'write') {
        if (!share.writable) return reply({ ok: false, error: '共享者未开启写入权限' });
        let fp = safeJoin(ROOT, req.path);
        if (!fp) return reply({ ok: false, error: '路径无效' });
        const dir = path.dirname(fp);
        const ext = path.extname(fp);
        const stem = path.basename(fp, ext);
        let i = 1;
        while (fs.existsSync(fp)) fp = path.join(dir, `${stem} (${i++})${ext}`);
        const resp = await fetch(
          `${BASE}/api/share/${share.id}/pull?transferId=${req.transferId}&token=${share.token}`
        );
        if (!resp.ok || !resp.body) return reply({ ok: false, error: '拉流失败' });
        await pipeline(Readable.fromWeb(resp.body), fs.createWriteStream(fp));
        reply({ ok: true, savedAs: path.basename(fp) });
      } else {
        reply({ ok: false, error: '未知操作' });
      }
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

async function main() {
  // ---------- 准备测试目录 ----------
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'hello.txt'), '你好，局域网共享！');
  fs.writeFileSync(path.join(ROOT, 'sub', 'world.txt'), 'world-内容-123');
  const bigBuf = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(path.join(ROOT, 'sub', 'big.bin'), bigBuf);

  // ---------- 启动服务器 ----------
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
  console.log('服务器已启动\n');

  try {
    // ---------- 共享者上线并注册共享 ----------
    console.log('【注册共享】');
    const owner = await connectSocket();
    const myShare = { id: null, token: null, writable: true };
    attachOwnerAgent(owner, () => myShare);
    let sharesSeen = null;
    owner.on('shares_update', (l) => { sharesSeen = l; });

    const reg = await emitAck(owner, 'share_register', { name: '测试共享', password: '1234', writable: true });
    check('注册共享成功', reg.ok && reg.shareId && reg.token);
    myShare.id = reg.shareId; myShare.token = reg.token;
    check('shares_update 广播含该共享', Array.isArray(sharesSeen) && sharesSeen.some((s) => s.id === reg.shareId && s.locked && s.writable));

    const dup = await emitAck(owner, 'share_register', { name: '第二个' });
    check('重复注册被拒绝', !dup.ok);

    // ---------- 访问者：密码校验 ----------
    console.log('【密码校验】');
    const guest = await connectSocket();
    const noPwd = await emitAck(guest, 'share_enter', { shareId: reg.shareId });
    check('无密码进入带锁共享被拒', !noPwd.ok && noPwd.needPassword);
    const badPwd = await emitAck(guest, 'share_enter', { shareId: reg.shareId, password: 'wrong' });
    check('错误密码被拒', !badPwd.ok && badPwd.needPassword);
    const goodPwd = await emitAck(guest, 'share_enter', { shareId: reg.shareId, password: '1234' });
    check('正确密码进入成功', goodPwd.ok && !!goodPwd.token);
    const gToken = goodPwd.token;

    // ---------- 浏览目录 ----------
    console.log('【目录浏览】');
    const listRoot = await (await fetch(`${BASE}/api/share/${reg.shareId}/list?path=&token=${gToken}`)).json();
    check('根目录列出 hello.txt 与 sub',
      listRoot.ok && listRoot.entries.some((e) => e.name === 'hello.txt' && e.kind === 'file') &&
      listRoot.entries.some((e) => e.name === 'sub' && e.kind === 'dir'));
    const listSub = await (await fetch(`${BASE}/api/share/${reg.shareId}/list?path=sub&token=${gToken}`)).json();
    check('子目录列出 world.txt 与 big.bin',
      listSub.ok && listSub.entries.length === 2 &&
      listSub.entries.some((e) => e.name === 'big.bin' && e.size === bigBuf.length));
    const listNoAuth = await (await fetch(`${BASE}/api/share/${reg.shareId}/list?path=`)).json();
    check('无 token 浏览被拒(401)', listNoAuth.ok === false && listNoAuth.needAuth === true);
    const listTrav = await fetch(`${BASE}/api/share/${reg.shareId}/list?path=${encodeURIComponent('../../')}&token=${gToken}`);
    check('路径穿越被拒(400)', listTrav.status === 400);

    // ---------- 下载 ----------
    console.log('【下载】');
    const dl = await fetch(`${BASE}/api/share/${reg.shareId}/file?path=${encodeURIComponent('hello.txt')}&token=${gToken}`);
    const dlText = await dl.text();
    check('下载 hello.txt 内容正确', dl.status === 200 && dlText === '你好，局域网共享！', `got: ${dlText}`);
    check('Content-Disposition 含 UTF-8 文件名',
      /filename\*=UTF-8''/.test(dl.headers.get('content-disposition') || ''));
    const dlBig = await fetch(`${BASE}/api/share/${reg.shareId}/file?path=${encodeURIComponent('sub/big.bin')}&token=${gToken}`);
    const dlBigBuf = Buffer.from(await dlBig.arrayBuffer());
    check('下载 3MB 大文件字节一致', dlBigBuf.length === bigBuf.length && dlBigBuf.equals(bigBuf));
    const dlMissing = await fetch(`${BASE}/api/share/${reg.shareId}/file?path=${encodeURIComponent('not-exist.txt')}&token=${gToken}`);
    check('下载不存在文件返回错误', dlMissing.status !== 200);
    const dlTrav = await fetch(`${BASE}/api/share/${reg.shareId}/file?path=${encodeURIComponent('../../server.js')}&token=${gToken}`);
    check('下载路径穿越被拒(400)', dlTrav.status === 400);

    // ---------- 写入 ----------
    console.log('【写入】');
    const upContent = '上传内容-来自访问者-' + 'x'.repeat(1024);
    const up = await fetch(`${BASE}/api/share/${reg.shareId}/write?path=${encodeURIComponent('sub/uploaded.txt')}&token=${gToken}`, {
      method: 'POST', body: upContent
    });
    const upRes = await up.json();
    check('写入 uploaded.txt 成功', up.status === 200 && upRes.ok && upRes.savedAs === 'uploaded.txt', JSON.stringify(upRes));
    check('写入内容落盘正确', fs.readFileSync(path.join(ROOT, 'sub', 'uploaded.txt'), 'utf8') === upContent);

    // 大文件写入（验证背压中转）
    const upBig = crypto.randomBytes(3 * 1024 * 1024);
    const upBigResp = await fetch(`${BASE}/api/share/${reg.shareId}/write?path=${encodeURIComponent('sub/big-up.bin')}&token=${gToken}`, {
      method: 'POST', body: upBig
    });
    const upBigRes = await upBigResp.json();
    check('写入 3MB 大文件成功', upBigResp.status === 200 && upBigRes.ok);
    check('写入大文件字节一致', fs.readFileSync(path.join(ROOT, 'sub', 'big-up.bin')).equals(upBig));

    // 重名自动改名
    const up2 = await fetch(`${BASE}/api/share/${reg.shareId}/write?path=${encodeURIComponent('sub/uploaded.txt')}&token=${gToken}`, {
      method: 'POST', body: 'second'
    });
    const up2Res = await up2.json();
    check('重名写入自动改名 uploaded (1).txt', up2Res.ok && up2Res.savedAs === 'uploaded (1).txt', JSON.stringify(up2Res));

    const upTrav = await fetch(`${BASE}/api/share/${reg.shareId}/write?path=${encodeURIComponent('../../evil.txt')}&token=${gToken}`, {
      method: 'POST', body: 'x'
    });
    check('写入路径穿越被拒(400)', upTrav.status === 400);

    // ---------- 修改密码 → 旧 token 失效 ----------
    console.log('【修改共享设置】');
    const upd = await emitAck(owner, 'share_update', { shareId: reg.shareId, password: 'abcd' });
    check('修改密码成功', upd.ok && upd.share.locked);
    const listOldToken = await (await fetch(`${BASE}/api/share/${reg.shareId}/list?path=&token=${gToken}`)).json();
    check('改密码后旧 token 被吊销', listOldToken.ok === false && listOldToken.needAuth === true);
    const reEnter = await emitAck(guest, 'share_enter', { shareId: reg.shareId, password: 'abcd' });
    check('新密码可进入', reEnter.ok && !!reEnter.token);
    const clr = await emitAck(owner, 'share_update', { shareId: reg.shareId, password: null });
    check('取消密码成功', clr.ok && !clr.share.locked);
    const enterNoPwd = await emitAck(guest, 'share_enter', { shareId: reg.shareId });
    check('取消密码后可直接进入', enterNoPwd.ok && !!enterNoPwd.token);

    // ---------- 只读共享禁止写入 ----------
    console.log('【只读共享】');
    const owner2 = await connectSocket();
    const roShare = { id: null, token: null, writable: false };
    attachOwnerAgent(owner2, () => roShare);
    const reg2 = await emitAck(owner2, 'share_register', { name: '只读共享', writable: false });
    roShare.id = reg2.shareId; roShare.token = reg2.token;
    const enterRo = await emitAck(guest, 'share_enter', { shareId: reg2.shareId });
    const wrRo = await fetch(`${BASE}/api/share/${reg2.shareId}/write?path=${encodeURIComponent('x.txt')}&token=${enterRo.token}`, {
      method: 'POST', body: 'x'
    });
    check('只读共享写入被拒(403)', wrRo.status === 403);
    const listRo = await (await fetch(`${BASE}/api/share/${reg2.shareId}/list?path=&token=${enterRo.token}`)).json();
    check('只读共享可正常浏览', listRo.ok === true);

    // ---------- 取消共享 / 断开清理 ----------
    console.log('【取消与清理】');
    const unreg = await emitAck(owner, 'share_unregister', { shareId: reg.shareId });
    check('取消共享成功', unreg.ok === true);
    const listGone = await fetch(`${BASE}/api/share/${reg.shareId}/list?path=&token=${reEnter.token}`);
    check('取消后浏览返回 404', listGone.status === 404);
    owner2.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    const guestShares = await new Promise((resolve) => {
      const h = (l) => { guest.off('shares_update', h); resolve(l); };
      guest.on('shares_update', h);
      guest.emit('share_enter', { shareId: reg2.shareId }, () => {});
      setTimeout(() => resolve(sharesSeen), 600);
    });
    check('共享者断线后共享被摘除', Array.isArray(guestShares) && !guestShares.some((s) => s.id === reg2.shareId),
      JSON.stringify(guestShares));

    owner.disconnect();
    guest.disconnect();
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
