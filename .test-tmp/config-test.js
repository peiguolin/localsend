/* 配置中心集成测试：文件加载 / env 覆盖 / 宿主机门禁 / 保存写文件 / 校验 / 翻译实时生效 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3100;
const BASE = `https://127.0.0.1:${PORT}`;
const CFG_FILE = path.join(__dirname, 'test-config.json');
const DB_FILE = path.join(__dirname, 'test-config.db');

let failures = 0;
let skipped = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function skip(name) { skipped++; console.log(`  ⊘ ${name}（引擎不可用，跳过）`); }

function getLanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = typeof net.family === 'string' ? net.family : `IPv${net.family}`;
      if (family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

async function main() {
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + s); } catch (_) { /* ignore */ } }
  fs.rmSync(CFG_FILE, { force: true });

  // 预置配置文件：文件值 vs env 覆盖的对照
  fs.writeFileSync(CFG_FILE, JSON.stringify({ translateUrl: 'off', fileTtlDays: 7, maxUploadMB: 10 }));

  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), LOCALSEND_DB_FILE: DB_FILE,
      LOCALSEND_CONFIG_FILE: CFG_FILE,
      LOCALSEND_LOCAL_ADDRS: '127.0.0.1,::1,::ffff:127.0.0.1',
      LOCALSEND_FILE_TTL_DAYS: '99' // env 应覆盖文件里的 7
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    serverProc.stdout.on('data', (d) => { if (String(d).includes('已启动')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('服务器启动超时')), 8000);
  });

  try {
    console.log('【文件加载与 env 覆盖】');
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    check('读取生效配置成功', cfg.ok && typeof cfg.config === 'object');
    check('配置文件值生效(maxUploadMB=10)', cfg.config.maxUploadMB === 10);
    check('单文件上限默认 2GB(maxFileMB=2048)', cfg.config.maxFileMB === 2048, JSON.stringify(cfg.config.maxFileMB));
    check('env 覆盖文件值(fileTtlDays=99)', cfg.config.fileTtlDays === 99);
    check('translateUrl=off 生效', cfg.config.translateUrl === 'off');

    console.log('【宿主机门禁】');
    const lanIP = getLanIP();
    if (lanIP) {
      const denied = await fetch(`https://${lanIP}:${PORT}/api/config`);
      check('非宿主机读取配置 403', denied.status === 403);
      const deniedPost = await fetch(`https://${lanIP}:${PORT}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { port: 4000 } })
      });
      check('非宿主机修改配置 403', deniedPost.status === 403);
    } else {
      skip('宿主机门禁（无局域网 IP）');
    }

    console.log('【保存与校验】');
    const r1 = await (await fetch(`${BASE}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { port: 4000, msgTtlDays: 15 } })
    })).json();
    check('保存成功且标注需重启', r1.ok && Array.isArray(r1.restartNeeded) &&
      r1.restartNeeded.includes('port') && !r1.restartNeeded.includes('translateUrl'), JSON.stringify(r1.restartNeeded));
    const onDisk = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    check('已写入配置文件', onDisk.port === 4000 && onDisk.msgTtlDays === 15 && onDisk.fileTtlDays === 7);
    const cfg2 = await (await fetch(`${BASE}/api/config`)).json();
    // 注：port 有 env(PORT=3100) 覆盖故不变；用无 env 覆盖的 msgTtlDays 验证生效
    check('保存后生效值更新(msgTtlDays=15)', cfg2.config.msgTtlDays === 15, JSON.stringify(cfg2.config));

    const bad1 = await fetch(`${BASE}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { maxUploadMB: 'abc' } })
    });
    check('类型非法被拒 400', bad1.status === 400);
    const bad2 = await fetch(`${BASE}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { noSuchKey: 1 } })
    });
    check('未知配置项被拒 400', bad2.status === 400);

    console.log('【翻译实时生效】');
    // 引擎在 5000 时：改回真实地址 → 立即可用；改回 off → 立即不可用
    let engineLive = false;
    try {
      const s = await fetch('http://127.0.0.1:5000/languages', { signal: AbortSignal.timeout(1500) });
      engineLive = s.ok;
    } catch (_) { engineLive = false; }
    if (engineLive) {
      const on = await (await fetch(`${BASE}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { translateUrl: 'http://127.0.0.1:5000' } })
      })).json();
      check('保存翻译地址无需重启', on.ok && !on.restartNeeded.includes('translateUrl'));
      const st1 = await (await fetch(`${BASE}/api/translate/status`)).json();
      check('翻译地址保存后即时可用', st1.ok && st1.available === true);
    } else {
      skip('翻译实时生效（本机无引擎）');
    }

    console.log('【前端资产】');
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    check('数据面板含配置卡', html.includes('id="dataConfigBox"'));
    const dp = fs.readFileSync(path.join(__dirname, '..', 'public', 'data-panel.js'), 'utf8');
    check('data-panel 含配置卡逻辑', dp.includes('loadConfigCard') && dp.includes('/api/config'));
    const up = fs.readFileSync(path.join(__dirname, '..', 'public', 'client-parts', 'upload.js'), 'utf8');
    check('前端单文件上限已到 2GB', up.includes('2 * 1024 * 1024 * 1024') && up.includes('文件超过 2GB 大小限制'));
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const rtf = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes-files.js'), 'utf8');
    check('服务端不再硬编码 200MB', !srv.includes('200MB') && !rtf.includes('200MB'));
    check('页面含语音消息控件', html.includes('id="micBtn"') && html.includes('id="voiceBar"'));
  } finally {
    serverProc.kill();
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + s); } catch (_) { /* ignore */ } }
    fs.rmSync(CFG_FILE, { force: true });
  }

  console.log(failures === 0 ? `\n全部通过 ✅${skipped ? `（跳过 ${skipped} 项）` : ''}` : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
