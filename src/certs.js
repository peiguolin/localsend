/* HTTPS 证书（File System Access API 要求安全上下文；缺失时用 openssl 自签生成） */
const fs = require('fs');
const { CERT_DIR, KEY_FILE, CERT_FILE } = require('./config');

function ensureCerts() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) return true;
  try {
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const { execSync } = require('child_process');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
      `-days 3650 -nodes -subj "/CN=localsend-chat" ` +
      `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: 'ignore' }
    );
    return fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE);
  } catch (_) {
    return false;
  }
}

// 读取证书凭据；不可用则打印指引并退出
function loadCredentials() {
  if (!ensureCerts()) {
    console.error('未找到 HTTPS 证书且自动生成失败。请手动执行：');
    console.error('  mkdir -p certs && openssl req -x509 -newkey rsa:2048 \\');
    console.error('    -keyout certs/key.pem -out certs/cert.pem -days 3650 -nodes \\');
    console.error('    -subj "/CN=localsend-chat" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"');
    process.exit(1);
  }
  return {
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE)
  };
}

module.exports = { ensureCerts, loadCredentials };
