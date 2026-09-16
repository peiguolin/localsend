/* AI 机器人：OpenAI 兼容 /v1/chat/completions 接入。
 * 全房间可用：任意房间 @机器人 触发；机器人以虚拟成员身份回复（isBot 标记，入库 + 广播）。
 * 配置（config center，均即时生效）：
 *   botEnabled / botName / botBaseUrl / botApiKey / botModel / botPrompt / botContextN / botTimeoutMs
 * 触发：仅 @提及（预留自动回复槽位，后续在 botTrigger 配置上扩展）。
 * 注意：API Key 只在服务端持有，GET /api/config 由 rt-config 掩码，客户端不可见。 */
const store = require('../db.js');
const state = require('./state');
const { currentConfig } = require('./config');
const { isLocalSocket } = require('./util');
const { chatLog, nextMsgId, chatLogPush } = require('./chatlog');

const BOT_SENDER_ID = 'bot';

// 启动时从 DB 恢复房间级机器人覆盖（跨重启持久）
function loadRoomBotFromDb() {
  let rows;
  try { rows = store.loadRoomBot(); } catch (_) { return; }
  for (const r of rows || []) {
    state.roomBotConfig.set(r.room, {
      enabled: r.enabled === null || r.enabled === undefined ? null : !!r.enabled,
      prompt: r.prompt === undefined ? null : r.prompt
    });
  }
}

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

// 构造请求参数（流式开关由调用方传）
function buildRequest(cfg, prompt, context, userText, stream) {
  const base = String(cfg.botBaseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置接口地址');
  return {
    url: `${base}/v1/chat/completions`,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.botApiKey ? { Authorization: `Bearer ${cfg.botApiKey}` } : {})
      },
      body: JSON.stringify({
        model: cfg.botModel || undefined,
        stream: !!stream,
        messages: [
          { role: 'system', content: prompt || `你是「${cfg.botName}」，局域网聊天室里的 AI 助手。用与用户一致的语言简洁回答。` },
          ...context,
          { role: 'user', content: userText }
        ]
      })
    }
  };
}

function httpError(r, j) {
  return new Error(`HTTP ${r.status}${j && j.error ? ': ' + ((j.error.message) || j.error) : ''}`);
}

// 流式调用：解析 OpenAI 兼容 SSE，每个增量回调 onDelta(piece, full)；返回完整文本。
// 端点若不支持流式（返回普通 JSON），自动退化为一次性返回。
async function streamLLM(cfg, prompt, context, userText, onDelta) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.botTimeoutMs || 60000);
  try {
    const { url, options } = buildRequest(cfg, prompt, context, userText, true);
    const r = await fetch(url, { ...options, signal: controller.signal });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw httpError(r, j);
    }
    // 非 SSE 响应（对端忽略了 stream 参数）→ 普通 JSON 退化
    if (!ct.includes('text/event-stream')) {
      const j = await r.json().catch(() => null);
      const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('接口返回为空');
      const text = content.trim();
      onDelta(text, text);
      return text;
    }
    // 解析 SSE：逐行 data: {...}，[DONE] 结束
    let buf = '';
    let full = '';
    const handleLine = (line) => {
      line = line.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let o;
      try { o = JSON.parse(payload); } catch (_) { return; }
      const piece = (o.choices && o.choices[0] && (
        (o.choices[0].delta && o.choices[0].delta.content) ||
        (o.choices[0].message && o.choices[0].message.content)
      )) || '';
      if (piece) {
        full += piece;
        onDelta(piece, full);
      }
    };
    for await (const chunk of r.body) {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    if (buf.trim()) handleLine(buf);
    if (!full.trim()) throw new Error('接口返回为空');
    return full.trim();
  } finally {
    clearTimeout(timer);
  }
}

function register(io, socket) {
  // 挂在 chat_message 上（rt-chat 先注册，先入库/广播，这里再触发）
  socket.on('chat_message', (data) => {
    const cfg = currentConfig();
    const room = String((data && data.room) || 'main');
    // 房间级覆盖：enabled=null 继承全局；true/false 覆盖本房间开关；prompt 覆盖本房间提示词
    const ov = state.roomBotConfig.get(room) || {};
    const enabled = (ov.enabled === null || ov.enabled === undefined) ? cfg.botEnabled : !!ov.enabled;
    if (!enabled) return;
    const text = String((data && data.text) || '').trim();
    if (!text || !mentionsBot(text, cfg.botName)) return; // 目前仅 @提及触发
    // 该用户被禁止 @机器人 → 静默不触发
    if (state.botBans.has(String(socket.data.clientId || ''))) return;
    if (generating.has(room)) return; // 该房间生成中，忽略重复触发
    generating.add(room);
    const botName = String(cfg.botName || '机器人');
    const prompt = ov.prompt || cfg.botPrompt; // 本房间自定义提示词优先

    (async () => {
      // 流式回复的临时气泡 id：bot_start/bot_delta/bot_error 用它定位同一条气泡；
      // 最终以正式 chat_message（含持久化 id）为准，迟到加入者/历史仍只看正式消息
      const tempId = nextMsgId();
      const startedAt = Date.now();
      io.to(room).emit('bot_start', { tempId, room, nickname: botName });
      try {
        const context = buildContext(room, socket.id, text, cfg.botContextN);
        const reply = await streamLLM(cfg, prompt, context, text, (piece, full) => {
          io.to(room).emit('bot_delta', { tempId, room, piece, full });
        });
        const msg = {
          id: nextMsgId(),
          type: 'text',
          room,
          senderId: BOT_SENDER_ID,
          clientId: 'bot:' + botName,
          nickname: botName,
          text: reply,
          mentions: [],
          timestamp: startedAt,
          isBot: true
        };
        chatLogPush(msg);
        store.insertMessage(msg);
        store.trimMessages(room);
        io.to(room).emit('bot_done', { tempId, room, id: msg.id });
        io.to(room).emit('chat_message', msg);
      } catch (e) {
        io.to(room).emit('bot_error', { tempId, room, error: e.message || '未知错误' });
      } finally {
        generating.delete(room);
      }
    })();
  });

  // 查询/设置某房间的机器人覆盖（宿主机或该房间房主）：enabled 三态（null=继承/true/false）、prompt（留空=继承）
  socket.on('room_bot_config', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = String((data && data.room) || 'main');
    const gr = room !== 'main' ? state.groupRooms.get(room) : null;
    const isOwner = !!(gr && gr.ownerClientId === socket.data.clientId);
    if (!isLocalSocket(socket) && !isOwner) return cb({ ok: false, error: '仅宿主机或房主可设置' });
    const cur = state.roomBotConfig.get(room) || { enabled: null, prompt: null };
    // 仅查询（客户端打开设置面板时预填）
    if (data && data.get && !('enabled' in data) && !('prompt' in data)) {
      return cb({ ok: true, enabled: cur.enabled, prompt: cur.prompt });
    }
    if (data && 'enabled' in data) cur.enabled = data.enabled === null || data.enabled === undefined ? null : !!data.enabled;
    if (data && 'prompt' in data) cur.prompt = data.prompt ? String(data.prompt) : null;
    state.roomBotConfig.set(room, cur);
    try { store.setRoomBot(room, cur.enabled, cur.prompt); } catch (_) { /* DB 不可用不阻塞 */ }
    cb({ ok: true, enabled: cur.enabled, prompt: cur.prompt });
  });
}

module.exports = { register, loadRoomBotFromDb };
