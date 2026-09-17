/* 聊天消息内存流水（供撤回/引用定位；封顶丢最旧）+ 引用快照 + @提及解析 */
const state = require('./state');
const { CHAT_LOG_MAX } = require('./config');

const chatLog = []; // {id, nickname, senderId, type, text|fileName, timestamp, recalled, ...}
let chatMsgSeq = 0;

function nextMsgId() {
  return `m${Date.now().toString(36)}${(chatMsgSeq++).toString(36)}`;
}

function chatLogPush(msg) {
  chatLog.push(msg);
  if (chatLog.length > CHAT_LOG_MAX) chatLog.shift();
  return msg;
}

function chatLogFind(id) {
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if (chatLog[i].id === id) return chatLog[i];
  }
  return null;
}

// 按房间清理内存消息索引（引用/撤回定位），不影响其他房间
function purgeChatLog(room) {
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if ((chatLog[i].room || 'main') === room) chatLog.splice(i, 1);
  }
}

// 按时间清理内存索引（消息保留策略过期联动）
function purgeChatLogBefore(cutoffTs) {
  for (let i = chatLog.length - 1; i >= 0; i--) {
    if ((chatLog[i].timestamp || 0) < cutoffTs) chatLog.splice(i, 1);
  }
}

// 引用快照：文本截断 80 字；文件/图片用占位描述；已撤回消息不可引用
function quoteSnapshot(msg) {
  if (!msg || msg.recalled) return null;
  let text = msg.text || '';
  if (msg.type === 'file') text = `[文件] ${msg.fileName || ''}`;
  else if (msg.type === 'image') text = `[图片] ${msg.fileName || ''}`;
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 80) text = text.slice(0, 80) + '…';
  return { id: msg.id, nickname: msg.nickname, text };
}

// @提及解析：在线昵称最长匹配优先；昵称右侧需为边界（非中英文数字连字符或结尾）
function parseMentions(text) {
  const nicks = Array.from(new Set(state.onlineUsers.values())).sort((a, b) => b.length - a.length);
  const found = new Set();
  for (const nick of nicks) {
    const needle = '@' + nick;
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      const after = text[idx + needle.length];
      if (after === undefined || !/[\w一-龥-]/.test(after)) {
        found.add(nick);
        break;
      }
      idx += needle.length;
    }
  }
  return Array.from(found);
}

// @全员判定：@所有人 / @all / @everyone（大小写不敏感；@all 需后跟边界防误伤 "call" 等）
// 注意 @所有人 后不能用 \b（JS 的 \b 对 CJK 无效），改用「非中英文数字」负向断言
const MENTION_ALL_RE = /@(?:所有人|everyone)(?![\w一-龥])|@all\b/i;
function hasMentionAll(text) {
  return MENTION_ALL_RE.test(String(text || ''));
}

module.exports = { chatLog, nextMsgId, chatLogPush, chatLogFind, purgeChatLog, purgeChatLogBefore, quoteSnapshot, parseMentions, hasMentionAll };
