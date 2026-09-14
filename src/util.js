/* 通用工具函数（无状态） */
const os = require('os');
const state = require('./state');

// multer/busboy 默认按 latin1 解码文件名，需还原为 UTF-8（浏览器 FormData 发送 UTF-8 文件名）
function decodeOriginalName(name) {
  try {
    const buf = Buffer.from(String(name), 'latin1');
    const utf8 = buf.toString('utf8');
    // 还原结果含替换字符说明原本不是 latin1 编码，保持原样
    return utf8.includes('�') ? String(name) : utf8;
  } catch (_) {
    return String(name);
  }
}

// Content-Disposition（RFC 5987，支持中文文件名）
function contentDisposition(filename, type = 'attachment') {
  const fallback = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// 昵称等展示文本禁止控制字符（C0/DEL）
function hasControlChars(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

// 宿主机判定：回环地址，或来源地址恰为本机任意网卡 IP（从本机用局域网 IP 访问也算宿主机）
// LOCALSEND_LOCAL_ADDRS 可显式指定（逗号分隔），主要用于测试与特殊部署
const ownAddrs = new Set(
  (process.env.LOCALSEND_LOCAL_ADDRS || '127.0.0.1,::1,::ffff:127.0.0.1')
    .split(',').map((s) => s.trim()).filter(Boolean)
);
if (!process.env.LOCALSEND_LOCAL_ADDRS) {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.address) ownAddrs.add(net.address);
      }
    }
  } catch (_) { /* 网卡枚举失败时退回仅回环 */ }
}

function isLocalAddr(addr) {
  const a = String(addr || '');
  return ownAddrs.has(a) || ownAddrs.has(a.replace(/^::ffff:/, ''));
}

function isLocalSocket(socket) {
  return isLocalAddr(socket && socket.handshake && socket.handshake.address);
}

function randomNickname() {
  return `用户${Math.floor(1000 + Math.random() * 9000)}`;
}

// 广播在线成员列表
function broadcastMembers(io) {
  const members = Array.from(state.onlineUsers.entries()).map(([id, nickname]) => ({ id, nickname }));
  io.emit('members_update', members);
}

// 局域网 IP 获取
function getLanIPs() {
  const result = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // 兼容 IPv4 字符串与数字格式
      const family = typeof net.family === 'string' ? net.family : `IPv${net.family}`;
      if (family === 'IPv4' && !net.internal) {
        result.push({ name, address: net.address });
      }
    }
  }
  return result;
}

module.exports = {
  decodeOriginalName, contentDisposition, hasControlChars,
  isLocalAddr, isLocalSocket, randomNickname, broadcastMembers, getLanIPs
};
