/* 表情回应 + 已读回执 集成测试（受限服务器：无宿主机）：
 * 表情回应：
 *   - 成员对消息点表情 → 全员收到 message_reaction(加)，聚合带 count/names/mine
 *   - 同人同表情再点 → 取消（action=remove），聚合为空
 *   - 多人点同一表情 → count 累加；room_history 带 reactions（DB 持久化，重连仍在）
 *   - 对不存在/不在该房间的消息回应 → 拒绝
 *   - 清空房间历史 → 回应连带清除
 * 已读回执：
 *   - B 上报已读到某时间点 → 发送者 A 收到 messages_read{msgIds, clientId}
 *   - 重复上报不重复广播；room_history 里自己的消息带 readCount/readBy
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3151;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-react-read.db');
const UPLOAD_DIR = path.join(__dirname, 'react-read-uploads');

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

function connectSocket(cid) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, {
      rejectUnauthorized: false, transports: ['websocket'], reconnection: false,
      auth: { clientId: cid }
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
  let a, b, c;
  try {
    a = await connectSocket('react-a');
    b = await connectSocket('react-b');
    const created = await emitAck(a.s, 'group_create', { targetIds: [b.s.id], name: '回应测试群' });
    check('群聊创建成功', created && created.ok && created.room, JSON.stringify(created));
    const roomId = created.room.id;

    console.log('【表情回应：点/取消/多人/持久化】');
    const gotMsg = waitEvent(b.s, 'chat_message', (m) => m && m.room === roomId && m.type === 'text' && m.text === '这条要收集回应');
    a.s.emit('chat_message', { text: '这条要收集回应', room: roomId, clientId: 'react-a' });
    const msg = await gotMsg;

    // B 点 👍 → A 收到广播（A 的视角 mine=false）
    const reactEvt1 = waitEvent(a.s, 'message_reaction', (d) => d && d.msgId === msg.id);
    const r1 = await emitAck(b.s, 'message_reaction', { room: roomId, msgId: msg.id, emoji: '👍' });
    check('B 点表情成功', r1 && r1.ok && r1.action === 'add' && r1.reactions.length === 1 && r1.reactions[0].emoji === '👍' && r1.reactions[0].count === 1, JSON.stringify(r1));
    const ev1 = await reactEvt1;
    check('A 收到 add 广播（A 视角 mine=false）', ev1 && ev1.action === 'add' && ev1.emoji === '👍' && !(ev1.reactions[0].clientIds || []).includes('react-a'), JSON.stringify(ev1 && ev1.reactions));

    // 同人同表情再点 → 取消
    const r2 = await emitAck(b.s, 'message_reaction', { room: roomId, msgId: msg.id, emoji: '👍' });
    check('同人同表情再点 = 取消', r2 && r2.ok && r2.action === 'remove' && r2.reactions.length === 0, JSON.stringify(r2));

    // 两人点同一表情 + B 再点一个 → count 累加、names 正确
    const r3a = await emitAck(b.s, 'message_reaction', { room: roomId, msgId: msg.id, emoji: '❤️' });
    const r3b = await emitAck(a.s, 'message_reaction', { room: roomId, msgId: msg.id, emoji: '❤️' });
    check('两人同表情 count=2', r3b && r3b.ok && r3b.reactions.length === 1 && r3b.reactions[0].count === 2, JSON.stringify(r3b));
    const r3c = await emitAck(b.s, 'message_reaction', { room: roomId, msgId: msg.id, emoji: '🎉' });
    check('B 加第二个表情', r3c && r3c.ok && r3c.reactions.length === 2);

    // 历史带 reactions（B 视角 mine 正确）
    const hist1 = await emitAck(b.s, 'room_history', { room: roomId });
    const hm = hist1 && hist1.history ? hist1.history.find((m) => m.id === msg.id) : null;
    check('room_history 带 reactions 聚合', hm && Array.isArray(hm.reactions) && hm.reactions.length === 2, JSON.stringify(hm && hm.reactions));
    check('B 自己的回应 mine=true', hm && hm.reactions.some((x) => x.emoji === '🎉' && x.mine === true), JSON.stringify(hm && hm.reactions));
    check('❤️ 聚合带两名昵称', hm && hm.reactions.find((x) => x.emoji === '❤️').names.length === 2);

    // 持久化：B 重连（同 clientId）后历史仍在
    b.s.disconnect();
    await sleep(150);
    const b2 = await connectSocket('react-b');
    const hist2 = await emitAck(b2.s, 'room_history', { room: roomId });
    const hm2 = hist2.history.find((m) => m.id === msg.id);
    check('重连后回应仍持久化（DB）', hm2 && hm2.reactions.length === 2, JSON.stringify(hm2 && hm2.reactions));

    // 异常路径
    const badMsg = await emitAck(b2.s, 'message_reaction', { room: roomId, msgId: 'm不存在', emoji: '👍' });
    check('对不存在消息回应被拒', badMsg && !badMsg.ok, JSON.stringify(badMsg));
    const outside = await connectSocket('react-outside');
    const nonMember = await emitAck(outside.s, 'message_reaction', { room: roomId, msgId: msg.id, emoji: '👍' });
    check('非成员回应被拒', nonMember && !nonMember.ok, JSON.stringify(nonMember));

    console.log('【已读回执】');
    // A 发一条新消息；B 上报已读 → A 收到 messages_read
    const gotMsg2 = waitEvent(b2.s, 'chat_message', (m) => m && m.room === roomId && m.text === '发给你看是否已读');
    a.s.emit('chat_message', { text: '发给你看是否已读', room: roomId, clientId: 'react-a' });
    const msg2 = await gotMsg2;
    const readEvt = waitEvent(a.s, 'messages_read', (d) => d && d.room === roomId && (d.msgIds || []).includes(msg2.id));
    const rd = await emitAck(b2.s, 'read_messages', { room: roomId, upToTs: msg2.timestamp });
    check('上报已读成功', rd && rd.ok && rd.count >= 1, JSON.stringify(rd));
    const rev = await readEvt;
    check('发送者收到 messages_read（含该 msgId + 读者）', rev && rev.msgIds.includes(msg2.id) && rev.clientId === 'react-b', JSON.stringify(rev));

    // 重复上报（同一时间点）→ 不再广播（reader 已存在）
    const again = await emitAck(b2.s, 'read_messages', { room: roomId, upToTs: msg2.timestamp });
    check('重复上报 count=0（不重复广播）', again && again.ok && again.count === 0, JSON.stringify(again));

    // 会话内 room_history 里 A 自己消息带 readCount/readBy
    const hist3 = await emitAck(a.s, 'room_history', { room: roomId });
    const ownMsg = hist3.history.find((m) => m.id === msg2.id);
    check('自己消息历史带已读信息', ownMsg && ownMsg.readCount >= 1 && Array.isArray(ownMsg.readBy) && ownMsg.readBy.some((x) => x.clientId === 'react-b'), JSON.stringify(ownMsg && ownMsg.readCount));

    console.log('【清空历史连带清回应】');
    const clear = await emitAck(a.s, 'room_history_clear', { room: roomId });
    check('房主清空历史成功', clear && clear.ok, JSON.stringify(clear));
    await sleep(100);
    const hist4 = await emitAck(a.s, 'room_history', { room: roomId });
    check('清空后历史为空（回应随之清除）', hist4 && hist4.ok && hist4.history.length === 0, JSON.stringify(hist4 && hist4.history.length));

    outside.s.disconnect();
    b2.s.disconnect();
  } catch (e) {
    check('测试流程无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    try { a && a.s.disconnect(); } catch (_) {}
    try { b && b.s.disconnect(); } catch (_) {}
    proc.kill();
    for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch (_) {} }
    try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
