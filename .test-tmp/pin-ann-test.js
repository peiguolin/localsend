/* 置顶消息 + 群公告 集成测试：
 * 权限用受限服务器（LOCALSEND_LOCAL_ADDRS 不含 127.0.0.1 → 无宿主机）：
 *   - 房主置顶/发公告 → 成员收到广播 + room_history 带 pins/announcement（DB 持久化）
 *   - 非房主置顶/发公告 → 拒绝
 *   - 重复置顶 → 拒绝
 *   - 清空房间历史 → 置顶连带清除、公告保留
 * 公共房公告用默认服务器（127.0.0.1 视为宿主机）：
 *   - 宿主机给 main 发公告 → 新连接 welcome 带 announcement
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3141;
const PORT2 = 3142;
const DB_FILE = path.join(__dirname, 'test-pin-ann.db');
const DB_FILE2 = path.join(__dirname, 'test-pin-ann-main.db');
const UPLOAD_DIR = path.join(__dirname, 'pin-ann-uploads');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emitAck = (s, e, d) => new Promise((res) => s.emit(e, d, res));

function startServer(port, dbFile, extraEnv) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      LOCALSEND_DB_FILE: dbFile,
      LOCALSEND_UPLOAD_DIR: UPLOAD_DIR,
      ...(extraEnv || {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });
}

function connectSocket(base, cid, extraAuth) {
  return new Promise((resolve, reject) => {
    const s = io(base, {
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
  for (const db of [DB_FILE, DB_FILE2]) {
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(db + suf); } catch (_) {} }
  }
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  // 受限服务器（无宿主机）：验证房主/非房主权限
  const proc = await startServer(PORT, DB_FILE, { LOCALSEND_LOCAL_ADDRS: '10.255.255.1' });
  // 默认服务器（127.0.0.1=宿主机）：验证公共房公告
  const proc2 = await startServer(PORT2, DB_FILE2);
  const BASE = `https://127.0.0.1:${PORT}`;
  const BASE2 = `https://127.0.0.1:${PORT2}`;
  let host, owner, member, owner2;
  try {
    owner = await connectSocket(BASE, 'owner-pin');
    member = await connectSocket(BASE, 'member-pin');
    const ownerS = owner.s, memberS = member.s;

    // 房主 ownerS 创建群聊拉 memberS
    const created = await emitAck(ownerS, 'group_create', { targetIds: [memberS.id] });
    check('群聊创建成功且带 inviteToken', created && created.ok && created.room && created.room.id && !!created.room.inviteToken, JSON.stringify(created));
    const roomId = created.room.id;

    console.log('【置顶消息（受限服务器：无宿主机）】');
    const gotMsg = waitEvent(memberS, 'chat_message', (m) => m && m.room === roomId && m.type === 'text');
    ownerS.emit('chat_message', { text: '这是一条要置顶的消息', room: roomId, clientId: 'owner-pin' });
    const msg = await gotMsg;
    check('成员收到房主消息', !!msg && !!msg.id, JSON.stringify(msg));

    const pinnedEvt = waitEvent(memberS, 'room_pinned', (d) => d && d.room === roomId);
    const pinRes = await emitAck(ownerS, 'room_pin_add', { room: roomId, msgId: msg.id });
    check('房主置顶成功', pinRes && pinRes.ok, JSON.stringify(pinRes));
    const pinEvt = await pinnedEvt;
    check('成员收到 room_pinned 广播', pinEvt && pinEvt.msgId === msg.id && pinEvt.msg && pinEvt.msg.text === '这是一条要置顶的消息');

    const hist1 = await emitAck(memberS, 'room_history', { room: roomId });
    check('room_history 带置顶列表', hist1 && hist1.ok && Array.isArray(hist1.pins) && hist1.pins.length === 1 && hist1.pins[0].msgId === msg.id, JSON.stringify(hist1 && hist1.pins));

    const denyPin = await emitAck(memberS, 'room_pin_add', { room: roomId, msgId: msg.id });
    check('非房主置顶被拒', denyPin && !denyPin.ok, JSON.stringify(denyPin));

    const dupPin = await emitAck(ownerS, 'room_pin_add', { room: roomId, msgId: msg.id });
    check('重复置顶被拒', dupPin && !dupPin.ok, JSON.stringify(dupPin));

    // 置顶持久化：owner 重连（同 clientId）后 room_history 仍有置顶
    owner.s.disconnect();
    await sleep(150);
    owner2 = await connectSocket(BASE, 'owner-pin');
    const hist2 = await emitAck(owner2.s, 'room_history', { room: roomId });
    check('重启会话后置顶仍持久化（DB）', hist2 && hist2.ok && Array.isArray(hist2.pins) && hist2.pins.length === 1, JSON.stringify(hist2 && hist2.pins));

    console.log('【群公告（受限服务器）】');
    const annEvt = waitEvent(memberS, 'room_announcement', (d) => d && d.room === roomId);
    const annRes = await emitAck(owner2.s, 'room_announcement_set', { room: roomId, text: '今晚八点开例会' });
    check('房主发布公告成功', annRes && annRes.ok && annRes.announcement && annRes.announcement.text === '今晚八点开例会', JSON.stringify(annRes));
    const annGot = await annEvt;
    check('成员收到 room_announcement 广播', annGot && annGot.text === '今晚八点开例会' && !!annGot.author);

    const hist3 = await emitAck(memberS, 'room_history', { room: roomId });
    check('room_history 带公告', hist3 && hist3.ok && hist3.announcement && hist3.announcement.text === '今晚八点开例会', JSON.stringify(hist3 && hist3.announcement));

    const denyAnn = await emitAck(memberS, 'room_announcement_set', { room: roomId, text: '越权公告' });
    check('非房主发公告被拒', denyAnn && !denyAnn.ok, JSON.stringify(denyAnn));

    console.log('【清空历史连带清置顶（公告保留）】');
    const clearRes = await emitAck(owner2.s, 'room_history_clear', { room: roomId });
    check('房主清空房间历史成功', clearRes && clearRes.ok, JSON.stringify(clearRes));
    await sleep(100);
    const hist4 = await emitAck(memberS, 'room_history', { room: roomId });
    check('清空后置顶列表为空', hist4 && hist4.ok && Array.isArray(hist4.pins) && hist4.pins.length === 0, JSON.stringify(hist4 && hist4.pins));
    check('清空历史后公告仍保留', hist4 && hist4.ok && hist4.announcement && hist4.announcement.text === '今晚八点开例会', JSON.stringify(hist4 && hist4.announcement));

    console.log('【公共房公告（默认服务器：宿主机）】');
    host = await connectSocket(BASE2, 'host-pin');
    const hostAnn = await emitAck(host.s, 'room_announcement_set', { room: 'main', text: '全员公告：服务器今晚重启' });
    check('宿主机发公共房公告成功', hostAnn && hostAnn.ok, JSON.stringify(hostAnn));
    const newbie = await connectSocket(BASE2, 'newbie-pin');
    check('新连接 welcome 带公告', newbie.w && newbie.w.announcement && newbie.w.announcement.text === '全员公告：服务器今晚重启', JSON.stringify(newbie.w && newbie.w.announcement));
    // 非宿主机给公共房发公告被拒（受限服务器上任何成员都不行）
    const denyMainAnn = await emitAck(owner2.s, 'room_announcement_set', { room: 'main', text: '越权公共公告' });
    check('非宿主机给公共房发公告被拒', denyMainAnn && !denyMainAnn.ok, JSON.stringify(denyMainAnn));

    newbie.s.disconnect();
    owner2.s.disconnect();
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { host && host.s.disconnect(); } catch (_) {}
    try { owner && owner.s.disconnect(); } catch (_) {}
    try { member && member.s.disconnect(); } catch (_) {}
    proc.kill();
    proc2.kill();
    for (const db of [DB_FILE, DB_FILE2]) {
      for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(db + suf); } catch (_) {} }
    }
    try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
