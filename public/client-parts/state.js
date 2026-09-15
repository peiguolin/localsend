/* 客户端共享运行时状态模块：通话/消息/群聊等功能分片读写同一份状态。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之前加载。
 * 挂到 window.chatApp.state 供 client.js 及全部功能分片复用。
 * 注意：本模块只定义状态容器与初始值，不含 DOM / socket 依赖（持久身份初始化除外）。 */
(function () {
  'use strict';

  const S = window.chatApp = window.chatApp || {};
  const st = S.state = S.state || {};

  // ---------- 持久身份 ----------
  // 同一浏览器生成一次，重进/换昵称/换设备不丢；用于判断"哪条消息是我发的"；
  // 也随握手发给服务端，服务端据此下发我加入的群聊房并自动加入对应 Socket.IO room
  const CLIENT_ID_KEY = 'localsend-client-id';
  st.myClientId = st.myClientId || '';
  if (!st.myClientId) {
    try { st.myClientId = localStorage.getItem(CLIENT_ID_KEY) || ''; } catch (_) { /* 非浏览器 */ }
    if (!st.myClientId) {
      st.myClientId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(CLIENT_ID_KEY, st.myClientId); } catch (_) { /* localStorage 不可用 */ }
    }
  }

  // ---------- 会话身份 ----------
  st.myNickname = st.myNickname || '';
  st.myId = st.myId || '';
  st.isLocalHost = false;

  // ---------- 群聊房间 ----------
  st.currentRoom = 'main';            // 当前正在查看的房间（默认公共房）
  st.myRooms = st.myRooms || [];      // 我加入的群聊房 [{id,name,members,...}]
  st.roomUnread = st.roomUnread || new Map(); // room -> 未读数（'main' 也统计）

  // ---------- 昵称编辑 ----------
  st.nickEditing = false;
  st.nickErrorTimer = null;

  // ---------- 成员列表 ----------
  st.latestMembers = st.latestMembers || [];       // 最新成员列表（@ 自动补全数据源）
  st.currentMembers = st.currentMembers || [];     // 最新成员 [{id, nickname}] 缓存（群呼/所选呼叫用）
  st.selectedMembers = st.selectedMembers || new Set(); // 多选呼叫的成员 id

  // ---------- 未读提醒 ----------
  st.unreadCount = 0;    // 页面未聚焦时的未读数（标签页标题 / favicon）
  st.pillCount = 0;      // 滚动到上方看历史时的新消息数（页内"新消息 N 条"浮条，与焦点无关）

  // ---------- 历史分页（往上滚懒加载） ----------
  st.oldestId = 0;       // 当前房间已加载最旧消息的 numericId（0=无更早）
  st.historyLoading = false;
  st.historyDone = false;

  // ---------- 消息提示音 ----------
  st.audioCtx = null;

  // ---------- 多方语音通话（WebRTC Mesh 房间模型） ----------
  // 状态机：idle → ringing(主叫等待) / incoming(被叫来电) → active(通话中) → idle
  // Mesh：每个成员与房间内其他每位成员各建一条 RTCPeerConnection（peers: Map<peerId, pc>）
  st.callState = st.callState || 'idle';
  st.roomId = '';                    // 当前通话房间 id
  st.myRole = '';                    // 'caller' | 'callee'
  st.callerId = '';                  // 房间发起者 socket id
  st.roster = st.roster || [];       // [{id, nickname}] 已接通成员（含自己）
  st.ringingTargets = st.ringingTargets || []; // 主叫侧：仍待接听的 [{id, nickname}]
  st.peers = st.peers || new Map();  // peerId -> RTCPeerConnection
  st.localStream = null;
  st.callTimer = null;
  st.callSec = 0;
  st.ringCtx = null;
  st.ringTimer = null;
  st.muted = false;

  // ---------- 消息存储（供引用/撤回/右键菜单定位） ----------
  st.msgStore = st.msgStore || new Map(); // id -> 消息原始数据（含 recalled 标记）

  // ---------- 表情选择器 ----------
  st.emojiActiveCat = st.emojiActiveCat || 'recent';
  st.emojiSearchQ = st.emojiSearchQ || '';

  // ---------- 右键菜单 / 长按 ----------
  st.ctxMenu = null;
  st.longPressTimer = null;
  st.longPressFired = false;

  // ---------- 消息翻译 ----------
  st.translationAvailable = false;

  // ---------- 引用回复 ----------
  st.quoting = null; // {id, nickname, text}

  // ---------- @ 自动补全 ----------
  st.acOpen = false;
  st.acItems = st.acItems || [];
  st.acIndex = 0;
  st.acTokenStart = -1;

  // ---------- 拉起群聊弹窗 ----------
  st.groupSel = st.groupSel || new Map(); // socketId -> nickname
})();
