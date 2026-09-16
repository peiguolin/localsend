/* 房间分享邀请链接 集成测试：
 * - group_create 返回 inviteToken；publicRoomInfo 含 inviteToken
 * - 新连接带 joinToken → 自动成为成员（welcome rooms 含该房 + 可发消息 + 房内成员收到系统提示）
 * - 加入的 clientId 持久化：同 clientId 不带 token 重连 → 仍在房间列表
 * - room_invite_reset：非房主拒绝；房主重置 → 新 token 生效、旧 token 失效
 * - 无效 token → 不加入任何房间
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3143;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-invite.db');
const UPLOAD_DIR = path.join(__dirname, 'invite-uploads');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emitAck = (s, e, d) => new Promise((res) => s.emit(e, d, res));

function startServer() {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_UPLOAD_DIR: UPLOAD_DIR, LOCALSEND_LOCAL_ADDRS: '10.255.255.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

function connectSocket(cid, extraAuth) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, {
      rejectUnauthorized: false, transports: ['websocket'], reconnection: false,
      auth: { clientId: cid, ...(extraAuth || {}) }
    });
    s.once('welcome', (w) => resolve({ s, w }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

function waitEvent(s, event, filter, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.off(event, h); reject(new Error(`等不到 ${event}`)); }, timeoutMs || 5000);
    const h = (d) => { if (!filter || filter(d)) { clearTimeout(t); s.off(event, h); resolve(d); } };
    s.on(event, h);
  });
}

async function main() {
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  const proc = await startServer();
  let owner, member, joiner, rejoin, oldTokUser, newTokUser, badTokUser;
  try {
    owner = await connectSocket('inv-owner');
    member = await connectSocket('inv-member');
    const created = await emitAck(owner.s, 'group_create', { targetIds: [member.s.id], name: '扫码测试群' });
    check('群聊创建成功', created && created.ok && created.room, JSON.stringify(created));
    const roomId = created.room.id;
    const token = created.room.inviteToken;
    check('创建响应带 inviteToken', !!token, JSON.stringify(created.room));

    console.log('【joinToken 扫码加入】');
    // 房内成员等待"通过邀请链接加入"系统消息
    const joinMsg = waitEvent(member.s, 'system_message', (d) => d && d.room === roomId && /邀请链接/.test(d.text || ''));
    joiner = await connectSocket('inv-joiner', { joinToken: token });
    check('带 token 连接 welcome rooms 含该房', joiner.w.rooms.some((r) => r.id === roomId), JSON.stringify(joiner.w.rooms.map((r) => r.id)));
    const sys = await joinMsg;
    check('房内成员收到邀请加入提示', !!sys, JSON.stringify(sys));

    // joiner 能发消息（成员校验通过）
    const gotMsg = waitEvent(member.s, 'chat_message', (m) => m && m.room === roomId && m.text === '扫码进来的第一句话');
    joiner.s.emit('chat_message', { text: '扫码进来的第一句话', room: roomId, clientId: 'inv-joiner' });
    const m1 = await gotMsg;
    check('通过邀请加入后可发言', !!m1 && m1.nickname, JSON.stringify(m1));

    // 成员身份持久化：同 clientId 不带 token 重连 → 仍在房间列表（clientRooms 恢复）
    joiner.s.disconnect();
    await sleep(150);
    rejoin = await connectSocket('inv-joiner');
    check('同 clientId 重连（无 token）仍在房间列表', rejoin.w.rooms.some((r) => r.id === roomId), JSON.stringify(rejoin.w.rooms.map((r) => r.id)));

    console.log('【room_invite_reset 权限 + 旧 token 失效】');
    const denyReset = await emitAck(member.s, 'room_invite_reset', { room: roomId });
    check('非房主重置邀请被拒', denyReset && !denyReset.ok, JSON.stringify(denyReset));
    const resetRes = await emitAck(owner.s, 'room_invite_reset', { room: roomId });
    check('房主重置邀请成功', resetRes && resetRes.ok && resetRes.room && resetRes.room.inviteToken && resetRes.room.inviteToken !== token, JSON.stringify(resetRes));
    const newToken = resetRes.room.inviteToken;

    oldTokUser = await connectSocket('inv-oldtok', { joinToken: token });
    check('旧 token 不再生效（未加入）', !oldTokUser.w.rooms.some((r) => r.id === roomId), JSON.stringify(oldTokUser.w.rooms.map((r) => r.id)));
    const deniedHist = await emitAck(oldTokUser.s, 'room_history', { room: roomId });
    check('旧 token 用户被拒绝访问房间历史', deniedHist && !deniedHist.ok, JSON.stringify(deniedHist));

    newTokUser = await connectSocket('inv-newtok', { joinToken: newToken });
    check('新 token 扫码加入成功', newTokUser.w.rooms.some((r) => r.id === roomId), JSON.stringify(newTokUser.w.rooms.map((r) => r.id)));

    console.log('【无效 token】');
    badTokUser = await connectSocket('inv-badtok', { joinToken: 'deadbeefdeadbeef' });
    check('无效 token 不加入任何房间', badTokUser.w.rooms.length === 0, JSON.stringify(badTokUser.w.rooms));

    badTokUser.s.disconnect();
    oldTokUser.s.disconnect();
    newTokUser.s.disconnect();
    rejoin.s.disconnect();
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { owner && owner.s.disconnect(); } catch (_) {}
    try { member && member.s.disconnect(); } catch (_) {}
    proc.kill();
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
    try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
