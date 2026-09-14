#!/usr/bin/env node
/* 数据库恢复脚本：用导出的备份替换当前 chat.db
 * 用法：npm run restore -- <备份文件路径>
 * 注意：必须在服务器停止状态下执行（运行中的服务器持有 SQLite 句柄，热替换会损坏数据） */
const fs = require('fs');
const path = require('path');

const backup = process.argv[2];
if (!backup) {
  console.error('用法：npm run restore -- <备份文件路径>');
  console.error('示例：npm run restore -- ~/Downloads/localsend-chat-20260911-1430.db');
  process.exit(1);
}

const src = path.resolve(backup);
if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
  console.error(`备份文件不存在：${src}`);
  process.exit(1);
}

// 校验是 SQLite 库文件（文件头 "SQLite format 3\0"）
const fd = fs.openSync(src, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
fs.closeSync(fd);
if (head.toString('latin1', 0, 15) !== 'SQLite format 3') {
  console.error('该文件不是有效的 SQLite 数据库（文件头校验失败）');
  process.exit(1);
}

const target = process.env.LOCALSEND_DB_FILE || path.join(__dirname, '..', 'data', 'chat.db');

// 备份当前库（以防万一）
if (fs.existsSync(target)) {
  const bak = `${target}.bak-${Date.now()}`;
  fs.copyFileSync(target, bak);
  console.log(`已把当前库备份到：${bak}`);
}

// 清理 WAL/SHM 残留后替换
for (const suffix of ['-wal', '-shm']) {
  try { fs.unlinkSync(target + suffix); } catch (_) { /* ignore */ }
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(src, target);

console.log(`恢复完成：${src} → ${target}`);
console.log('现在可以（重新）启动服务器：npm start');
