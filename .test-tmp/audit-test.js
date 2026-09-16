/* 管理审计日志测试：剔除/禁言等管理操作与配置修改落审计表，宿主机可查，重启仍在。 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3132;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-audit.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE },
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
    setTimeout(() => reject(new Error('connect timeout')), 4000);
  });
}

const emitAck = (sock, event, data) => new Promise((res) => sock.emit(event, data, res));

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {} }

  console.log('【第 1 次启动：产生管理操作 + 配置修改】');
  let proc = await startServer(PORT);
  let host;
  try {
    host = await connectSocket('host-audit');
    // 禁言某用户（其不在线也可记录状态 + 审计）
    const mute = await emitAck(host.s, 'admin_mute', { clientId: 'cX', minutes: 15 });
    check('禁言成功', mute && mute.ok);
    // 禁机器人再恢复，产生两条
    await emitAck(host.s, 'admin_botban', { clientId: 'cX', banned: true });
    await emitAck(host.s, 'admin_botban', { clientId: 'cX', banned: false });
    // 配置修改（POST /api/config，宿主机）
    const cr = await fetch(`${BASE}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { remindTickMs: 30000 } })
    });
    const cj = await cr.json();
    check('配置保存成功', cj && cj.ok);

    const audit = await emitAck(host.s, 'admin_audit', { limit: 50 });
    check('查询审计成功', audit && audit.ok);
    const actions = (audit.entries || []).map((e) => e.action);
    check('记录了禁言 mute', actions.includes('mute'));
    check('记录了禁/恢复机器人', actions.includes('botban') && actions.includes('unbotban'));
    check('记录了配置修改 config', actions.includes('config'));
    const muteEntry = (audit.entries || []).find((e) => e.action === 'mute');
    check('禁言条目含操作者与目标', muteEntry && muteEntry.actor && muteEntry.target === 'cX' && /15/.test(muteEntry.detail));
    const cfgEntry = (audit.entries || []).find((e) => e.action === 'config');
    check('配置条目 detail 含配置键', cfgEntry && /remindTickMs/.test(cfgEntry.detail));
  } finally {
    try { host && host.s.disconnect(); } catch (_) {}
    proc.kill();
    await sleep(400);
  }

  console.log('【重启：审计日志应保留】');
  proc = await startServer(PORT);
  try {
    host = await connectSocket('host-audit2');
    const audit = await emitAck(host.s, 'admin_audit', { limit: 50 });
    const actions = (audit.entries || []).map((e) => e.action);
    check('重启后仍能查到禁言记录', actions.includes('mute'));
    check('重启后仍能查到配置修改记录', actions.includes('config'));
  } catch (e) {
    check('重启验证无异常', false, String(e && e.message));
    console.error(e && e.stack);
  } finally {
    proc.kill();
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) {} }
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
