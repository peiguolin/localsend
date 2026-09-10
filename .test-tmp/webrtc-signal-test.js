/* WebRTC 语音通话信令集成测试：
 * 用真实服务器 + 多个 socket.io-client 验证：呼叫/接听/拒绝/取消/挂断、
 * SDP/ICE 转发、忙线/离线/自己呼叫自己、断线自动结束通话、成员列表带 ID。
 * （不涉及真实媒体流，浏览器端的 RTCPeerConnection 由人工验证）
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3101;
const BASE = `https://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { rejectUnauthorized: false, transports: ['websocket'] });
    s.on('welcome', (w) => resolve({ s, id: w.id, nickname: w.nickname }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function waitEvent(sock, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeout);
    sock.once(event, (d) => { clearTimeout(t); resolve(d); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  try {
    const a = await connectSocket(); // 主叫
    const b = await connectSocket(); // 被叫
    const c = await connectSocket(); // 第三方（忙线/离线测试用）

    console.log('【成员列表带 ID】');
    const memP = waitEvent(a.s, 'members_update');
    await sleep(200);
    const members = await memP.catch(() => null);
    check('members_update 为对象数组', Array.isArray(members) && members.every((m) => m && typeof m.id === 'string' && typeof m.nickname === 'string'));
    check('包含主叫自己(id 为 socket id)', Array.isArray(members) && members.some((m) => m.id === a.id && m.nickname === a.nickname));
    check('包含被叫', Array.isArray(members) && members.some((m) => m.id === b.id));

    console.log('【完整呼叫流程：呼叫 → 振铃 → 接听 → SDP/ICE → 挂断】');
    // 主叫发起
    const incP = waitEvent(b.s, 'incoming_call');
    const ringP = waitEvent(a.s, 'call_ringing');
    a.s.emit('call_user', { targetId: b.id });
    const inc = await incP;
    const ring = await ringP;
    check('被叫收到 incoming_call', inc.fromId === a.id && inc.fromName === a.nickname && !!inc.callId);
    check('主叫收到 call_ringing', ring.toId === b.id && ring.toName === b.nickname && ring.callId === inc.callId);

    // 主叫先发 offer（被叫接听前暂存）
    const offer = { type: 'offer', sdp: 'fake-offer-sdp' };
    a.s.emit('rtc_offer', { toId: b.id, sdp: offer });
    // 被叫接听
    const accP = waitEvent(a.s, 'call_accepted');
    b.s.emit('call_accept', { callId: inc.callId, fromId: a.id });
    const acc = await accP;
    check('主叫收到 call_accepted', acc.toId === b.id && acc.toName === b.nickname);

    // 被叫回 answer（此时接听前收到的 offer 已消费，直接回 answer 模拟）
    const ansP = waitEvent(a.s, 'rtc_answer');
    b.s.emit('rtc_answer', { toId: a.id, sdp: { type: 'answer', sdp: 'fake-answer-sdp' } });
    const ans = await ansP;
    check('主叫收到转发来的 rtc_answer', ans.fromId === b.id && ans.sdp.type === 'answer');

    // ICE 双向转发
    const iceP = waitEvent(b.s, 'rtc_ice');
    a.s.emit('rtc_ice', { toId: b.id, candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host' } });
    const ice = await iceP;
    check('被叫收到转发的 ICE', ice.fromId === a.id && ice.candidate.candidate.includes('candidate:1'));

    // 主叫挂断
    const endP = waitEvent(b.s, 'call_ended');
    a.s.emit('call_end', { toId: b.id });
    const ended = await endP;
    check('被叫收到 call_ended', ended.fromId === a.id && ended.reason === 'hangup');

    console.log('【拒绝】');
    const rejP = waitEvent(a.s, 'call_ringing');
    a.s.emit('call_user', { targetId: c.id });
    await rejP;
    const rejectedP = waitEvent(a.s, 'call_rejected');
    c.s.emit('call_reject', { callId: 'x', fromId: a.id });
    await rejectedP;
    check('主叫收到 call_rejected', true);

    console.log('【取消】');
    const cancP = waitEvent(c.s, 'incoming_call');
    a.s.emit('call_user', { targetId: c.id });
    const cancInc = await cancP;
    const cancelledP = waitEvent(c.s, 'call_cancelled');
    a.s.emit('call_cancel', { callId: cancInc.callId, toId: c.id });
    await cancelledP;
    check('被叫收到 call_cancelled', true);

    console.log('【忙线】');
    // 建立 a ↔ c 通话
    const incC = waitEvent(c.s, 'incoming_call');
    a.s.emit('call_user', { targetId: c.id });
    const incCData = await incC;
    c.s.emit('call_accept', { callId: incCData.callId, fromId: a.id });
    await waitEvent(a.s, 'call_accepted');
    // 此时 b 呼叫 a → 应 busy
    const busyP = waitEvent(b.s, 'call_busy');
    b.s.emit('call_user', { targetId: a.id });
    const busy = await busyP;
    check('呼叫通话中的人 → call_busy', busy.targetId === a.id);
    // 清理通话
    a.s.emit('call_end', { toId: c.id });
    await waitEvent(c.s, 'call_ended').catch(() => {});

    console.log('【自己呼叫自己 / 离线目标】');
    const selfFail = waitEvent(a.s, 'call_failed');
    a.s.emit('call_user', { targetId: a.id });
    const sf = await selfFail;
    check('自己呼叫自己 → call_failed', sf.reason === 'offline');
    const offP = waitEvent(a.s, 'call_failed');
    a.s.emit('call_user', { targetId: 'nonexistent-socket-id' });
    const off = await offP;
    check('呼叫离线 ID → call_failed', !!off.error);

    console.log('【断线自动结束通话】');
    const incD = waitEvent(c.s, 'incoming_call');
    a.s.emit('call_user', { targetId: c.id });
    const incDData = await incD;
    c.s.emit('call_accept', { callId: incDData.callId, fromId: a.id });
    await waitEvent(a.s, 'call_accepted');
    const endOffP = waitEvent(c.s, 'call_ended');
    a.s.disconnect();
    const endOff = await endOffP;
    check('对方断线 → call_ended(reason=offline)', endOff.fromId === a.id && endOff.reason === 'offline');

    b.s.disconnect(); c.s.disconnect();
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
