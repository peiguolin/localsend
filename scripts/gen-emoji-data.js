// 生成 public/vendor/emoji-data.js（前端表情数据）
// 来源: node_modules/@emoji-mart/data/sets/15/native.json（Unicode 15.0 基础 emoji，8 分类）
// 用法: node scripts/gen-emoji-data.js
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', '@emoji-mart', 'data', 'sets', '15', 'native.json');
const OUT = path.join(__dirname, '..', 'public', 'vendor', 'emoji-data.js');

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const categories = src.categories.map((c) => ({ id: c.id, e: c.emojis }));
const emojis = {};
for (const [id, v] of Object.entries(src.emojis)) {
  emojis[id] = {
    n: v.name,
    k: v.keywords || [],
    c: (v.skins && v.skins[0] && v.skins[0].native) || ''
  };
}
const count = Object.keys(emojis).length;
const header = [
  '/* 表情数据（自动生成，勿手改）',
  ` * 来源: @emoji-mart/data/sets/15/native.json（Unicode 15.0，${count} 个基础 emoji，${categories.length} 分类）`,
  ' * 重新生成: node scripts/gen-emoji-data.js',
  ' */',
  'window.EMOJI_DATA = '
].join('\n');
fs.writeFileSync(OUT, header + JSON.stringify({ categories, emojis }) + ';\n');
console.log(`written ${OUT} (${fs.statSync(OUT).size} bytes, ${count} emojis)`);
