/* 安全头 + 进程兜底测试：
 * 1) securityHeaders 中间件给响应打上 CSP / nosniff / frame 等头（纯单测）
 * 2) 真实启动服务器后 GET / 确实带这些头，且页面仍 200（CSP 未误伤静态资源）
 * 3) unhandledRejection 被兜底：触发未捕获 Promise 拒绝，进程不退出 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---------- 1) 中间件纯单测 ----------
const { securityHeaders, CSP, installProcessGuards } = require(path.join(__dirname, '..', 'src', 'guard.js'));
const headers = {};
securityHeaders({}, { setHeader: (k, v) => { headers[k] = v; }, }, () => {});
console.log('【安全头中间件】');
check('设置 Content-Security-Policy', typeof headers['Content-Security-Policy'] === 'string' && headers['Content-Security-Policy'].includes("default-src 'self'"));
check("CSP 默认同源且禁 object/frame-ancestors", CSP.includes("object-src 'none'") && CSP.includes("frame-ancestors 'none'"));
check('放行 blob/data 图片与媒体（灯箱/语音/视觉）', CSP.includes('img-src') && CSP.includes('blob:') && CSP.includes('data:'));
check('放行内联主题脚本', CSP.includes("script-src 'self' 'unsafe-inline'"));
check('X-Content-Type-Options=nosniff', headers['X-Content-Type-Options'] === 'nosniff');
check('X-Frame-Options=DENY', headers['X-Frame-Options'] === 'DENY');
check('Referrer-Policy=no-referrer', headers['Referrer-Policy'] === 'no-referrer');
check('Permissions-Policy 限制摄像头/麦克风为 self', /camera=\(self\)/.test(headers['Permissions-Policy'] || ''));
check('installProcessGuards 是函数', typeof installProcessGuards === 'function');

// ---------- 3) unhandledRejection 不应使进程退出（隔离子进程，避免污染本测试进程） ----------
console.log('【进程兜底】');
const probe = spawnSync(process.execPath, ['-e', `
  require(${JSON.stringify(path.join(__dirname, '..', 'src', 'guard.js'))}).installProcessGuards(null);
  Promise.reject(new Error('deliberate-unhandled'));
  setTimeout(() => { console.log('SURVIVED'); process.exit(0); }, 200);
`], { encoding: 'utf8' });
check('未捕获 rejection 后进程仍存活到定时器结束', probe.status === 0 && probe.stdout.includes('SURVIVED'), 'status=' + probe.status + ' stderr=' + probe.stderr.slice(0, 200));
check('兜底打印了 unhandledRejection 日志', /unhandledRejection/.test(probe.stderr || ''));

// ---------- 2) 真实服务器返回安全头 ----------
const PORT = 3140;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-guard.db');
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + s); } catch (_) {} }

const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE },
  stdio: ['ignore', 'pipe', 'pipe']
});
let started = false;
proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
proc.stderr.on('data', () => {});

(async () => {
  // 等待启动
  for (let i = 0; i < 80; i++) { if (started) break; await new Promise((r) => setTimeout(r, 100)); }
  try {
    console.log('【真实服务器响应头】');
    const r = await fetch(BASE + '/', { method: 'GET' });
    check('首页仍可访问 200', r.status === 200, 'status=' + r.status);
    check('响应带 CSP 头', /default-src 'self'/.test(r.headers.get('content-security-policy') || ''));
    check('响应带 nosniff', r.headers.get('x-content-type-options') === 'nosniff');
    check('响应带 X-Frame-Options', r.headers.get('x-frame-options') === 'DENY');
    // 静态 JS 资源也带头（中间件在 static 之前）
    const rj = await fetch(BASE + '/client.js');
    check('静态 JS 同样带安全头', rj.status === 200 && /default-src/.test(rj.headers.get('content-security-policy') || ''));
  } catch (e) {
    check('真实服务器头检查无异常', false, String(e && e.message));
  } finally {
    try { proc.kill('SIGTERM'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + s); } catch (_) {} }
  }
  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
})();
