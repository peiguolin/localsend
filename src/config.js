/* 全局配置中心：localsend.config.json 文件（宿主机可改）+ 环境变量覆盖
 * 优先级：环境变量（临时/测试覆盖） > localsend.config.json > 默认值
 * 宿主机可在「数据」面板的配置卡里查看与修改（写入 localsend.config.json，部分需重启）
 * 所有业务常量从这里导出，各模块不得直接读 process.env */
const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = process.env.LOCALSEND_CONFIG_FILE || path.join(ROOT_DIR, 'localsend.config.json');

// ---------- 配置项定义：默认值 + 类型 + 对应环境变量 + 是否需要重启生效 ----------
const CONFIG_DEFS = {
  port:          { def: 3000,  type: 'int',   env: 'PORT',                       restart: true },
  uploadDir:     { def: '',    type: 'str',   env: 'LOCALSEND_UPLOAD_DIR',       restart: true },
  dbFile:        { def: '',    type: 'str',   env: 'LOCALSEND_DB_FILE',          restart: true },
  localAddrs:    { def: '',    type: 'str',   env: 'LOCALSEND_LOCAL_ADDRS',      restart: true },
  fileTtlDays:   { def: 30,    type: 'int',   env: 'LOCALSEND_FILE_TTL_DAYS',    restart: true },
  maxUploadMB:   { def: 2048,  type: 'float', env: 'LOCALSEND_MAX_UPLOAD_MB',    restart: true },
  msgTtlDays:    { def: 0,     type: 'int',   env: 'LOCALSEND_MSG_TTL_DAYS',     restart: true },
  remindTickMs:  { def: 30000, type: 'int',   env: 'LOCALSEND_REMIND_TICK_MS',   restart: true },
  translateUrl:  { def: '',    type: 'str',   env: 'LOCALSEND_TRANSLATE_URL',    restart: false },
  translateGtx:  { def: false, type: 'bool',  env: 'LOCALSEND_TRANSLATE_GTX',    restart: true }
};

// 读取配置文件（不存在或损坏则用默认）
function loadFileConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch (_) { /* 无文件或损坏 → 全默认 */ }
  return {};
}

function coerce(def, type, v) {
  if (v === undefined || v === null || v === '') return def;
  if (type === 'int') { const n = Number(v); return Number.isInteger(n) ? n : def; }
  if (type === 'float') { const n = Number(v); return Number.isFinite(n) ? n : def; }
  if (type === 'bool') return v === true || v === '1' || v === 'true';
  return String(v);
}

// 解析出最终生效的配置（文件 → env 覆盖）
function resolveConfig() {
  const fileCfg = loadFileConfig();
  const out = {};
  for (const [k, d] of Object.entries(CONFIG_DEFS)) {
    let v = coerce(d.def, d.type, fileCfg[k]);
    const envV = process.env[d.env];
    if (envV !== undefined && envV !== '') v = coerce(d.def, d.type, envV);
    out[k] = v;
  }
  return out;
}

const cfg = resolveConfig();

// 把配置写回文件（保留未知键；返回当前生效值与需重启项）
function writeConfigFile(updates) {
  const cur = loadFileConfig();
  for (const [k, v] of Object.entries(updates || {})) {
    if (!(k in CONFIG_DEFS)) continue;
    const d = CONFIG_DEFS[k];
    cur[k] = coerce(d.def, d.type, v);
  }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2));
  // 重算生效值（env 覆盖权保留在 resolveConfig 内）
  Object.assign(cfg, resolveConfig());
  return { config: currentConfig(), restartNeeded: Object.keys(updates || {}).filter((k) => CONFIG_DEFS[k] && CONFIG_DEFS[k].restart) };
}

// 面板展示用：最终生效值 + 是否需要重启
function currentConfig() {
  const out = {};
  for (const [k, d] of Object.entries(CONFIG_DEFS)) {
    out[k] = cfg[k];
    out[`${k}Restart`] = d.restart;
  }
  return out;
}

// ---------- 派生常量（沿用原导出名，兼容各模块） ----------
const PORT = cfg.port;

// 上传根目录可用环境变量/配置文件覆盖（测试用独立目录，避免污染真实 uploads/）
const UPLOAD_DIR = cfg.uploadDir || path.join(ROOT_DIR, 'uploads');
const META_FILE = path.join(UPLOAD_DIR, '.meta.json');
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB

// 断点续传分片大小与临时目录
const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB/片
const TMP_DIR = path.join(UPLOAD_DIR, '.tmp'); // 未完成分片暂存区

// HTTPS 证书路径
const CERT_DIR = path.join(ROOT_DIR, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');

// 可在线预览的图片类型白名单（不含 SVG：SVG 可内嵌脚本，出于安全一律按普通文件处理）
const IMAGE_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

// 常见文件类型 → 归档分类目录（按扩展名小写匹配，未匹配的归入 other）
const FILE_CATEGORIES = {
  // 文本类
  '.txt': 'text', '.md': 'text', '.log': 'text', '.csv': 'text', '.json': 'text', '.xml': 'text',
  '.yml': 'text', '.yaml': 'text', '.ini': 'text', '.conf': 'text', '.rtf': 'text', '.srt': 'text',
  // 文档类
  '.doc': 'document', '.docx': 'document', '.pdf': 'document', '.xls': 'document', '.xlsx': 'document',
  '.ppt': 'document', '.pptx': 'document', '.odt': 'document', '.ods': 'document', '.odp': 'document',
  '.wps': 'document', '.pages': 'document', '.numbers': 'document', '.key': 'document',
  // 压缩包类
  '.zip': 'archive', '.rar': 'archive', '.7z': 'archive', '.tar': 'archive', '.gz': 'archive',
  '.bz2': 'archive', '.xz': 'archive', '.zst': 'archive', '.iso': 'archive',
  // 图片类（在线预览仍走 /images）
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.bmp': 'image', '.ico': 'image', '.tiff': 'image', '.svg': 'image',
  // 音视频类
  '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio', '.aac': 'audio', '.ogg': 'audio', '.m4a': 'audio',
  '.wma': 'audio', '.ape': 'audio', '.opus': 'audio',
  '.mp4': 'video', '.mkv': 'video', '.avi': 'video', '.mov': 'video', '.webm': 'video',
  '.flv': 'video', '.wmv': 'video', '.m4v': 'video', '.mpg': 'video', '.mpeg': 'video', '.ts': 'video',
  // 代码类
  '.js': 'code', '.ts': 'code', '.jsx': 'code', '.tsx': 'code', '.py': 'code', '.java': 'code',
  '.c': 'code', '.cpp': 'code', '.h': 'code', '.hpp': 'code', '.go': 'code', '.rs': 'code',
  '.rb': 'code', '.php': 'code', '.html': 'code', '.css': 'code', '.scss': 'code', '.less': 'code',
  '.sh': 'code', '.bat': 'code', '.ps1': 'code', '.sql': 'code', '.vue': 'code', '.swift': 'code',
  '.kt': 'code', '.scala': 'code', '.lua': 'code', '.pl': 'code', '.r': 'code', '.dart': 'code',
  '.json5': 'code', '.toml': 'code', '.dockerfile': 'code', '.makefile': 'code',
  // 程序/安装包类
  '.exe': 'program', '.msi': 'program', '.apk': 'program', '.app': 'program', '.dmg': 'program',
  '.deb': 'program', '.rpm': 'program', '.jar': 'program', '.bat2': 'program',
  // 字体类
  '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font', '.eot': 'font',
  // 其他
  '.db': 'other', '.sqlite': 'other', '.torrent': 'other', '.srt2': 'other'
};

function fileCategory(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return FILE_CATEGORIES[ext] || 'other';
}

// 时间子目录：YYYYMMDD（如 20260827）
function dateDirName(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// 归档目录：uploads/<类型>/<YYYYMMDD>，不存在则创建
function ensureArchiveDir(category, dateDir) {
  const dir = path.join(UPLOAD_DIR, category, dateDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 确保 uploads 目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 文件夹共享中转的超时
const TRANSFER_START_TIMEOUT = 60 * 1000;   // 共享者开始推/拉流的最长等待
const OWNER_ACK_TIMEOUT = 30 * 1000;        // list/read 操作的共享者响应超时
const WRITE_ACK_TIMEOUT = 30 * 60 * 1000;   // write 操作需覆盖整个传输时长

// 白板容量上限
const WB_MAX_STROKES = 1500;          // 历史笔迹数上限
const WB_MAX_POINTS_PER_STROKE = 5000; // 单笔点数上限
const WB_MAX_TOTAL_POINTS = 200000;    // 历史总点数上限（超出丢最旧）
const WB_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CURSOR_PALETTE = ['#e11d48', '#d97706', '#059669', '#2563eb', '#7c3aed', '#db2777', '#0891b2', '#65a30d'];

// 屏幕共享观看上限（Mesh 拓扑下共享者为每个观看者独立编码，限制人数防过载）
const SS_MAX_VIEWERS = 8;

// 聊天消息流水与撤回
const CHAT_LOG_MAX = 500;
const RECALL_WINDOW = 2 * 60 * 1000; // 撤回时限 2 分钟

// ---------- 数据生命周期（保留策略） ----------
const FILE_TTL_DAYS = cfg.fileTtlDays;
const MAX_UPLOAD_BYTES = cfg.maxUploadMB * 1024 * 1024; // uploads 容量上限（LRU 删最旧），0=不限制
const MSG_TTL_DAYS = cfg.msgTtlDays;
const TMP_STALE_MS = 24 * 60 * 60 * 1000;   // .tmp 未完成分片过期时间（24h）
const SWEEP_INTERVAL = 60 * 60 * 1000;      // 定期清扫间隔（1h）
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;   // 孤儿文件至少存在 1h 才删（防误删上传中的文件）

// 日程提醒
const REMIND_TICK_MS = cfg.remindTickMs;
const REMIND_LATE_MS = 30 * 60 * 1000;      // 触发时间已过去 30 分钟以上则静默标记（重启防爆）

// 消息翻译
const TRANSLATE_URL = cfg.translateUrl;
const TRANSLATE_GTX = cfg.translateGtx;

module.exports = {
  ROOT_DIR, CONFIG_FILE, CONFIG_DEFS, PORT, currentConfig, writeConfigFile,
  UPLOAD_DIR, META_FILE, MAX_FILE_SIZE, CHUNK_SIZE, TMP_DIR,
  CERT_DIR, KEY_FILE, CERT_FILE, IMAGE_MIMES, FILE_CATEGORIES,
  fileCategory, dateDirName, ensureArchiveDir,
  TRANSFER_START_TIMEOUT, OWNER_ACK_TIMEOUT, WRITE_ACK_TIMEOUT,
  WB_MAX_STROKES, WB_MAX_POINTS_PER_STROKE, WB_MAX_TOTAL_POINTS, WB_COLOR_RE, CURSOR_PALETTE,
  SS_MAX_VIEWERS, CHAT_LOG_MAX, RECALL_WINDOW,
  FILE_TTL_DAYS, MAX_UPLOAD_BYTES, MSG_TTL_DAYS, TMP_STALE_MS, SWEEP_INTERVAL, ORPHAN_MIN_AGE_MS,
  REMIND_TICK_MS, REMIND_LATE_MS,
  TRANSLATE_URL, TRANSLATE_GTX
};
