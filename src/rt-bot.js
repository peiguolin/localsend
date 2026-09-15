/* AI 机器人：OpenAI 兼容 /v1/chat/completions 接入。
 * 全房间可用：任意房间 @机器人 触发；机器人以虚拟成员身份回复（isBot 标记，入库 + 广播）。
 * 配置（config center，均即时生效）：
 *   botEnabled / botName / botBaseUrl / botApiKey / botModel / botPrompt / botContextN / botTimeoutMs
 * 触发：仅 @提及（预留自动回复槽位，后续在 botTrigger 配置上扩展）。
 * 注意：API Key 只在服务端持有，GET /api/config 由 rt-config 掩码，客户端不可见。 */
const store = require('../db.js');
const { currentConfig } = require('./config');
const { chatLog, nextMsgId, chatLogPush } = require('./chatlog');

const BOT_SENDER_ID = 'bot';

// 同房间同一时刻只允许一个生成任务（防连点刷爆 API）
const generating = new Set();

// @提及检测：昵称右侧需为边界（与 chatlog.parseMentions 同规则）
function mentionsBot(text, name) {
  if (!name) return false;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('@' + esc + '(?![\\w一-龥-])').test(text || '');
}

// 取房间最近上下文（去掉刚入库的当前消息），拼成 OpenAI 对话消息
function buildContext(room, socketId, curText, n) {
  const roomMsgs = chatLog.filter((m) => (m.room || 'main') === room && !m.recalled);
  const last = roomMsgs[roomMsgs.length - 1];
  // rt-chat 先入库，最后一条通常是刚发的当前消息 → 去掉，稍后单独追加为 user 回合
  if (last && last.senderId === socketId && String(last.text || '') === String(curText || '').trim()) {
    roomMsgs.pop();
  }
  return roomMsgs.slice(-(n || 10)).map((m) => ({
    role: m.clientId && String(m.clientId).indexOf('bot:') === 0 ? 'assistant' : 'user',
    content: `${m.nickname}: ${m.text || (m.type === 'image' ? '[图片]' : m.type === 'file' ? '[文件]' : '')}`
  }));
}

// 调 OpenAI 兼容接口；返回纯文本
async function callLLM(cfg, prompt, context, userText) {
  const base = String(cfg.botBaseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置接口地址');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.botTimeoutMs || 60000);
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.botApiKey ? { Authorization: `Bearer ${cfg.botApiKey}` } : {})
      },
      body: JSON.stringify({
        model: cfg.botModel || undefined,
        messages: [
          { role: 'system', content: prompt || `你是「${cfg.botName}」，局域网聊天室里的 AI 助手。用与用户一致的语言简洁回答。` },
          ...context,
          { role: 'user', content: userText }
        ]
      }),
      signal: controller.signal
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`HTTP ${r.status}${j && j.error ? ': ' + ((j.error.message) || j.error) : ''}`);
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('接口返回为空');
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

function register(io, socket) {
  // 挂在 chat_message 上（rt-chat 先注册，先入库/广播，这里再触发）
  socket.on('chat_message', (data) => {
    const cfg = currentConfig();
    if (!cfg.botEnabled) return;
    const text = String((data && data.text) || '').trim();
    if (!text || !mentionsBot(text, cfg.botName)) return; // 目前仅 @提及触发
    const room = String((data && data.room) || 'main');
    if (generating.has(room)) return; // 该房间生成中，忽略重复触发
    generating.add(room);
    const botName = String(cfg.botName || '机器人');

    (async () => {
      try {
        io.to(room).emit('system_message', { room, text: `🤖 ${botName} 正在思考…` });
        const context = buildContext(room, socket.id, text, cfg.botContextN);
        const reply = await callLLM(cfg, cfg.botPrompt, context, text);
        const msg = {
          id: nextMsgId(),
          type: 'text',
          room,
          senderId: BOT_SENDER_ID,
          clientId: 'bot:' + botName,
          nickname: botName,
          text: reply,
          mentions: [],
          timestamp: Date.now(),
          isBot: true
        };
        chatLogPush(msg);
        store.insertMessage(msg);
        store.trimMessages(room);
        io.to(room).emit('chat_message', msg);
      } catch (e) {
        io.to(room).emit('system_message', { room, text: `🤖 ${botName} 出错了：${e.message || '未知错误'}` });
      } finally {
        generating.delete(room);
      }
    })();
  });
}

module.exports = { register };
