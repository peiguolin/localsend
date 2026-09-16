/* qrcode-generator 内联库冒烟测试：
 * - require 可加载（CommonJS 导出，供 Node 冒烟）
 * - qrcode(0,'M') 创建实例、addData/make 后可 createDataURL / createImgTag
 */
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function main() {
  const mod = require(path.join(__dirname, '..', 'public', 'vendor', 'qrcode.js'));
  check('require 返回函数（UMD 导出）', typeof mod === 'function');
  const qr = mod(0, 'M');
  check('实例含 addData/make', typeof qr.addData === 'function' && typeof qr.make === 'function');
  qr.addData('https://127.0.0.1:3000/?join=abcdef1234567890');
  qr.make();
  const url = qr.createDataURL(4, 8);
  check('createDataURL 产出 data URL', typeof url === 'string' && url.startsWith('data:image/gif;base64,'));
  const img = qr.createImgTag(4, 8);
  check('createImgTag 产出 <img>', typeof img === 'string' && img.startsWith('<img'));
  check('getModuleCount 为正整数', Number.isInteger(qr.getModuleCount()) && qr.getModuleCount() > 0);

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
