/* 消息翻译集成测试：可用性探测 / 真实引擎翻译 / 缓存命中 / CJK 跳过 / 校验与限速 / 未配置降级 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3100;
const BASE = `https://127.0.0.1:${PORT}`;
const DB_FILE = path.join(__dirname, 'test-translate.db');

let failures = 0;
let skipped = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function skip(name) { skipped++; console.log(`  ⊘ ${name}（引擎不可用，跳过）`); }

function hasCJK(s) {
  return /[一-龥]/.test(s);
}

function startServer(port, extraEnv = {}) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), LOCALSEND_DB_FILE: DB_FILE, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(proc); });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error(`服务器(${port})启动超时`)), 8000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postTranslate(text, target) {
  const r = await fetch(`${BASE}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target ? { text, target } : { text })
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }

  console.log('【引擎配置模式】');
  const proc1 = await startServer(PORT, { LOCALSEND_TRANSLATE_URL: 'http://127.0.0.1:5000' });
  try {
    const status = await (await fetch(`${BASE}/api/translate/status`)).json();
    check('status 报告可用(libretranslate)', status.ok && status.available === true && status.engine === 'libretranslate');

    // 探测真实引擎是否真的活着（决定引擎相关断言是否跳过）
    const probe = await postTranslate('hello');
    await sleep(1100);
    const engineAlive = probe.body.ok === true;

    if (engineAlive) {
      const r1 = await postTranslate('The quick brown fox jumps over the lazy dog.');
      check('真实翻译返回中文译文', r1.body.ok && hasCJK(r1.body.translation), r1.body.translation);
      check('首次未命中缓存', r1.body.cached === false);
      await sleep(1100);
      const r2 = await postTranslate('The quick brown fox jumps over the lazy dog.');
      check('同文本第二次命中缓存', r2.body.ok && r2.body.cached === true);
    } else {
      skip('真实引擎翻译与缓存');
    }

    await sleep(1100);
    const r3 = await postTranslate('你好世界，这条已经是中文');
    check('CJK 文本直接跳过', r3.body.ok && r3.body.skipped === 'already_target_lang');

    await sleep(1100);
    const r4 = await postTranslate('');
    check('空文本 400', r4.status === 400);
    await sleep(1100);
    const r5 = await postTranslate('x'.repeat(5001));
    check('超长文本 400', r5.status === 400);
    await sleep(1100);
    const r6 = await postTranslate('hello', 'fr');
    check('不支持的目标语言 400', r6.status === 400);

    await sleep(1100);
    await postTranslate('ratelimit-1');
    const r8 = await postTranslate('ratelimit-2');
    check('限速：1 秒内第二请求 429', r8.status === 429);
  } finally {
    proc1.kill();
  }

  console.log('【自动探测与显式关闭】');
  // 不传 LOCALSEND_TRANSLATE_URL：本机 5000 有引擎 → 自动接入
  const proc2 = await startServer(3101);
  try {
    const status2 = await (await fetch(`https://127.0.0.1:3101/api/translate/status`)).json();
    const engineAlive = status2.ok && status2.available === true && status2.engine === 'libretranslate';
    if (engineAlive) {
      check('未配置时自动探测本机引擎成功', true);
    } else {
      skip('自动探测（本机无默认引擎）');
    }
  } finally {
    proc2.kill();
  }

  // 显式 off：关闭且不自动探测
  const proc3 = await startServer(3102, { LOCALSEND_TRANSLATE_URL: 'off', LOCALSEND_TRANSLATE_GTX: '0' });
  try {
    const status3 = await (await fetch(`https://127.0.0.1:3102/api/translate/status`)).json();
    check('off 时 status 报告不可用', status3.ok && status3.available === false);
    const r = await fetch(`https://127.0.0.1:3102/api/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' })
    });
    check('off 时翻译返回 503', r.status === 503);
  } finally {
    proc3.kill();
  }

  console.log('【前端资产】');
  const pub = path.join(__dirname, '..', 'public');
  const chat = fs.readFileSync(path.join(pub, 'client-parts', 'chat.js'), 'utf8');
  const util = fs.readFileSync(path.join(pub, 'client-parts', 'util.js'), 'utf8');
  check('chat 分片右键菜单含「翻译成中文」', chat.includes('翻译成中文') && chat.includes('translateMessage'));
  check('前端有 CJK 跳过启发式', util.includes('mostlyCJK'));
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  check('译文块样式存在', css.includes('.translate-block'));

  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suffix); } catch (_) { /* ignore */ } }

  console.log(failures === 0 ? `\n全部通过 ✅${skipped ? `（跳过 ${skipped} 项）` : ''}` : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
