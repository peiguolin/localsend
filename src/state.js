/* 跨模块共享的运行时状态（单例；Map/数组按引用共享，可变属性直接读写本对象） */
module.exports = {
  onlineUsers: new Map(),      // socketId -> nickname
  groupRooms: new Map(),       // roomId -> { id, name, ownerClientId, ownerNick, members:[{clientId,nickname}], createdAt, online? }
  clientRooms: new Map(),      // clientId -> Set<roomId>（该 client 加入的群聊房，用于 welcome 下发与重连恢复）

  // 多方语音通话（WebRTC Mesh）：
  // callRooms: roomId -> { ownerId, members:Set<socketId>(已接通), ringing:Set<socketId>(振铃) }
  // memberRooms: socketId -> roomId（振铃中或通话中，一个用户同时只在一个房间）
  callRooms: new Map(),
  memberRooms: new Map(),

  // 文件夹共享
  shares: new Map(),           // shareId -> { id, name, ownerId, ownerNick, salt, passwordHash, canWrite, writable, createdAt }
  shareTokens: new Map(),      // token -> { shareId, socketId, isOwner }
  pendingTransfers: new Map(), // transferId -> { kind:'push'|'pull', shareId, req?, res, started, timer }

  // 实时白板
  wbStrokes: [],               // {id, authorId, author, color, size, tool, pts:[[x,y]...]} 已完成笔迹历史
  wbTotalPoints: 0,            // 历史总点数（可变属性：state.wbTotalPoints += n）
  cursorColors: new Map(),     // socketId -> 分配的光标颜色
  wbCursors: new Map(),        // socketId -> {x, y} 最后上报的光标位置

  // 屏幕共享（全站同时一个）：null | { presenterId, presenterName, startedAt, viewers:Set<socketId> }
  screenShare: null,

  // 用户管理（宿主机操作；持久化到 SQLite user_admin 表，跨重启恢复）
  mutes: new Map(),          // clientId -> 禁言截止时间戳（untilTs）
  botBans: new Set(),        // clientId（禁止 @机器人 触发）
  bans: new Map(),           // clientId -> { nickname, at }（封禁：禁止重新连接）

  // 房间级机器人覆盖（持久化到 SQLite room_bot 表）：roomId -> { enabled: null|true|false, prompt: null|string }
  roomBotConfig: new Map(),

  // 发言限流（内存态）：clientId -> { times: number[], strikes: number, lastStrikeAt: number }
  rateHits: new Map(),

  // 机器人续聊窗口（内存态）：roomId -> { clientId, expireAt }
  // 某次 @机器人 成功后，同一用户在窗口内发普通消息（不必再 @）即继续对话；超时/退出词结束
  botFollowup: new Map()
};
