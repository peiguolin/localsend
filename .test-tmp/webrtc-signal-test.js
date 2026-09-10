/* WebRTC 多方语音通话信令集成测试（房间/Mesh 模型）：
 * 用真实服务器 + 多个 socket.io-client 验证：1:1 全流程、多选群呼、
 * 中途加入、离开、全拒绝、取消、忙线/离线/自己呼叫自己、断线自动离开。
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

function waitEvent(sock, event, timeout = 2500) {
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
    const a = await connectSocket(); // 主叫 A
    const b = await connectSocket(); // 被叫 B
    const c = await connectSocket(); // 被叫 C

    console.log('【成员列表带 ID】');
    const memP = waitEvent(a.s, 'members_update');
    await sleep(200);
    const members = await memP.catch(() => null);
    check('members_update 为对象数组', Array.isArray(members) && members.every((m) => m && typeof m.id === 'string' && typeof m.nickname === 'string'));
    check('包含主叫自己(id 为 socket id)', Array.isArray(members) && members.some((m) => m.id === a.id && m.nickname === a.nickname));
    check('包含被叫 B/C', Array.isArray(members) && members.some((m) => m.id === b.id) && members.some((m) => m.id === c.id));

    console.log('【1:1 全流程：呼叫 → 振铃 → 接听(加入) → SDP/ICE → 挂断(离开)】');
    const incP = waitEvent(b.s, 'incoming_call');
    const ringP = waitEvent(a.s, 'call_ringing');
    a.s.emit('call_user', { targets: [b.id] });
    const inc = await incP;
    const ring = await ringP;
    check('被叫收到 incoming_call', inc.roomId === ring.roomId && inc.fromId === a.id && inc.fromName === a.nickname && !!inc.roomId);
    check('主叫收到 call_ringing(含目标)', ring.roomId === inc.roomId && Array.isArray(ring.targets) && ring.targets.some((t) => t.id === b.id));

    // 被叫接听 → 双方收到 room_member_joined
    const joinedA = waitEvent(a.s, 'room_member_joined');
    const joinedB = waitEvent(b.s, 'room_member_joined');
    b.s.emit('call_accept', { roomId: inc.roomId });
    const ja = await joinedA;
    const jb = await joinedB;
    check('主叫收到新人加入', ja.roomId === inc.roomId && ja.member.id === b.id && ja.members.some((m) => m.id === a.id) && ja.members.some((m) => m.id === b.id));
    check('被叫也收到(含自己, 用于主动发 offer)', jb.roomId === inc.roomId && jb.member.id === b.id && jb.members.length === 2);

    // 新成员 B 向既有成员 A 发 offer → A 回 answer
    const offerP = waitEvent(a.s, 'rtc_offer');
    b.s.emit('rtc_offer', { toId: a.id, roomId: inc.roomId, sdp: { type: 'offer', sdp: 'fake-offer' } });
    const off = await offerP;
    check('主叫收到 offer(带 roomId)', off.fromId === b.id && off.roomId === inc.roomId && off.sdp.type === 'offer');
    const ansP = waitEvent(b.s, 'rtc_answer');
    a.s.emit('rtc_answer', { toId: b.id, roomId: inc.roomId, sdp: { type: 'answer', sdp: 'fake-answer' } });
    const ans = await ansP;
    check('被叫收到 answer(带 roomId)', ans.fromId === a.id && ans.roomId === inc.roomId && ans.sdp.type === 'answer');
    // ICE 双向
    const iceP = waitEvent(b.s, 'rtc_ice');
    a.s.emit('rtc_ice', { toId: b.id, roomId: inc.roomId, candidate: { candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host' } });
    const ice = await iceP;
    check('被叫收到 ICE(带 roomId)', ice.fromId === a.id && ice.roomId === inc.roomId && ice.candidate.candidate.includes('candidate:1'));
    // 挂断 → 对方收到 room_member_left
    const leftP = waitEvent(b.s, 'room_member_left');
    a.s.emit('call_end', { roomId: inc.roomId });
    const left = await leftP;
    check('被叫收到离开(挂断)', left.memberId === a.id && left.reason === 'hangup');

    console.log('【多选群呼：A 呼叫 B+C】');
    const incB = waitEvent(b.s, 'incoming_call');
    const incC = waitEvent(c.s, 'incoming_call');
    const ringG = waitEvent(a.s, 'call_ringing');
    a.s.emit('call_user', { targets: [b.id, c.id] });
    const [gincB, gincC, gring] = await Promise.all([incB, incC, ringG]);
    check('B、C 都收到 incoming_call', gincB.roomId === gring.roomId && gincC.roomId === gring.roomId && gincB.fromId === a.id);
    check('振铃目标含 B、C', gring.targets.length === 2 && gring.targets.some((t) => t.id === b.id) && gring.targets.some((t) => t.id === c.id));

    // B 先接听
    const gja = waitEvent(a.s, 'room_member_joined');
    b.s.emit('call_accept', { roomId: gincB.roomId });
    const gjaData = await gja;
    check('B 加入后 A 收到(成员含 A/B)', gjaData.roomId === gincB.roomId && gjaData.members.length === 2 && gjaData.members.some((m) => m.id === b.id));
    // B(新成员) 发 offer 给 A
    const gOffP = waitEvent(a.s, 'rtc_offer');
    b.s.emit('rtc_offer', { toId: a.id, roomId: gincB.roomId, sdp: { type: 'offer', sdp: 'o1' } });
    await gOffP;

    console.log('【中途加入：C 在通话进行中接听】');
    const gja2 = waitEvent(a.s, 'room_member_joined');
    const gjb2 = waitEvent(b.s, 'room_member_joined');
    const gjc2 = waitEvent(c.s, 'room_member_joined');
    c.s.emit('call_accept', { roomId: gincC.roomId });
    const [cja, cjb, cjc] = await Promise.all([gja2, gjb2, gjc2]);
    check('C 加入后全员收到(成员=A/B/C)', cja.members.length === 3 && cjb.members.length === 3 && cjc.members.length === 3);
    // 新成员 C 向 A、B 各发 offer（C 是发起 offer 的一方）
    const cOffA = waitEvent(a.s, 'rtc_offer');
    const cOffB = waitEvent(b.s, 'rtc_offer');
    c.s.emit('rtc_offer', { toId: a.id, roomId: gincC.roomId, sdp: { type: 'offer', sdp: 'o2a' } });
    c.s.emit('rtc_offer', { toId: b.id, roomId: gincC.roomId, sdp: { type: 'offer', sdp: 'o2b' } });
    await Promise.all([cOffA, cOffB]);
    check('C 向 A、B 各发 offer(新成员主动)', true);

    // C 离开 → A、B 收到离开，房间仍有 2 人（不结束）
    const cLeftA = waitEvent(a.s, 'room_member_left');
    const cLeftB = waitEvent(b.s, 'room_member_left');
    c.s.emit('call_end', { roomId: gincC.roomId });
    const [clA, clB] = await Promise.all([cLeftA, cLeftB]);
    check('C 离开后 A/B 收到, 房间继续', clA.memberId === c.id && clB.memberId === c.id && clA.reason === 'hangup');

    // A 挂断结束整个通话 → B 收到离开且只剩自己
    const endB = waitEvent(b.s, 'room_member_left');
    a.s.emit('call_end', { roomId: gincB.roomId });
    const eb = await endB;
    check('B 收到 A 离开', eb.memberId === a.id);

    console.log('【忙线：B 在通话中时被呼叫 → 主叫侧跳过并提示】');
    // A 与 B 建立通话
    const incB2 = waitEvent(b.s, 'incoming_call');
    a.s.emit('call_user', { targets: [b.id] });
    const incB2d = await incB2;
    b.s.emit('call_accept', { roomId: incB2d.roomId });
    await waitEvent(a.s, 'room_member_joined');
    // C 呼叫 A(通话中) + B(通话中) → 全部忙线 → call_failed(nobody)
    const busyP = waitEvent(c.s, 'call_failed');
    c.s.emit('call_user', { targets: [a.id, b.id] });
    const busyF = await busyP;
    check('呼叫通话中的 A+B → call_failed(nobody, 含忙线名单)', busyF.reason === 'nobody' && busyF.busy.length === 2);
    // C 呼叫 B(忙) + C 自己以外的空闲者不存在 → 部分忙线场景：B 忙、无空闲 → 仍 nobody
    const busyP2 = waitEvent(c.s, 'call_failed');
    c.s.emit('call_user', { targets: [b.id, 'nonexistent'] });
    const busyF2 = await busyP2;
    check('忙线+离线混合 → call_failed(nobody, busy=1, offline=1)', busyF2.busy.length === 1 && busyF2.offline.length === 1);
    // 清理
    a.s.emit('call_end', { roomId: incB2d.roomId });
    await waitEvent(b.s, 'room_member_left').catch(() => {});

    console.log('【全拒绝：A 呼叫 B，B 拒绝 → A 收到 all_rejected】');
    const incR = waitEvent(b.s, 'incoming_call');
    a.s.emit('call_user', { targets: [b.id] });
    const incRd = await incR;
    const rejP = waitEvent(a.s, 'call_rejected');
    const allRejP = waitEvent(a.s, 'call_failed');
    b.s.emit('call_reject', { roomId: incRd.roomId });
    const rej = await rejP;
    const allRej = await allRejP;
    check('A 收到拒绝通知', rej.memberId === b.id && rej.memberName === b.nickname);
    check('全拒绝后 A 收到 call_failed(all_rejected)', allRej.reason === 'all_rejected');

    console.log('【取消：A 呼叫 B、C 后取消 → B/C 收到 call_cancelled】');
    const incCan = waitEvent(b.s, 'incoming_call');
    const incCanC = waitEvent(c.s, 'incoming_call');
    a.s.emit('call_user', { targets: [b.id, c.id] });
    const incCanD = await incCan;
    await incCanC;
    const cancB = waitEvent(b.s, 'call_cancelled');
    const cancC = waitEvent(c.s, 'call_cancelled');
    a.s.emit('call_end', { roomId: incCanD.roomId });
    await Promise.all([cancB, cancC]);
    check('B、C 都收到取消', true);

    console.log('【自己呼叫自己 / 空目标】');
    const selfFail = waitEvent(a.s, 'call_failed');
    a.s.emit('call_user', { targets: [a.id] });
    const sf = await selfFail;
    check('自己呼叫自己 → call_failed(empty)', sf.reason === 'empty' || sf.reason === 'nobody');
    const offP = waitEvent(a.s, 'call_failed');
    a.s.emit('call_user', { targets: ['nonexistent-socket-id'] });
    const offd = await offP;
    check('呼叫离线 ID → call_failed', !!offd.error);

    console.log('【断线自动离开房间】');
    const incD = waitEvent(b.s, 'incoming_call');
    a.s.emit('call_user', { targets: [b.id] });
    const incDd = await incD;
    b.s.emit('call_accept', { roomId: incDd.roomId });
    await waitEvent(a.s, 'room_member_joined');
    const leftOff = waitEvent(b.s, 'room_member_left');
    a.s.disconnect();
    const lo = await leftOff;
    check('对方断线 → room_member_left(reason=offline)', lo.memberId === a.id && lo.reason === 'offline');

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
