/* 深色模式结构校验：
 * 1) :root 中定义的每个 CSS 变量在深色块中都有覆盖（防新增变量遗忘）
 * 2) 已知写死亮色的选择器都有深色覆盖
 * 3) index.html 主题初始化脚本在样式表之前执行、含切换按钮
 * 4) client.js 切换逻辑使用同一 localStorage 键 */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(PUB, 'client.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function extractVars(block) {
  const vars = new Set();
  const re = /--([\w-]+)\s*:/g;
  let m;
  while ((m = re.exec(block))) vars.add(m[1]);
  return vars;
}

const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
const darkMatch = css.match(/html\[data-theme='dark'\]\s*\{([^}]*)\}/);
check(':root 变量块存在', !!rootMatch);
check('深色变量块存在', !!darkMatch);

const rootVars = extractVars(rootMatch ? rootMatch[1] : '');
const darkVars = extractVars(darkMatch ? darkMatch[1] : '');
const missing = [...rootVars].filter((v) => !darkVars.has(v));
check(`:root 全部 ${rootVars.size} 个变量在深色块中均有覆盖`, missing.length === 0, missing.join(', '));

// 写死亮色的关键选择器必须有深色覆盖
const needOverride = [
  '.msg.other .msg-bubble',
  '.member-list li:hover',
  '.row-file:hover',
  '.tag',
  '.call-chip',
  '.call-mute',
  '.my-name-input',
  '.board-swatch.active'
];
for (const sel of needOverride) {
  const re = new RegExp(`html\\[data-theme='dark'\\][^{]*${sel.replace(/[.*[\]]/g, '\\$&')}[^{]*\\{`);
  check(`深色覆盖存在: ${sel}`, re.test(css));
}

// 主题初始化脚本必须出现在样式表引用之前（防首屏闪烁）
const scriptIdx = html.indexOf("localStorage.getItem('localsend-theme')");
const cssIdx = html.indexOf('<link rel="stylesheet"');
check('主题初始化脚本存在', scriptIdx !== -1);
check('初始化脚本在样式表之前执行', scriptIdx !== -1 && cssIdx !== -1 && scriptIdx < cssIdx);
check('初始化脚本设置 data-theme 属性', html.includes("setAttribute('data-theme'"));
check('默认跟随系统 prefers-color-scheme', html.includes('prefers-color-scheme: dark'));
check('顶栏含主题切换按钮', html.includes('id="themeToggle"'));

// client.js 切换逻辑与初始化脚本使用同一存储键
check('client.js 使用同一 localStorage 键', client.includes("'localsend-theme'"));
check('client.js 切换 data-theme', client.includes("setAttribute('data-theme', next)"));

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
