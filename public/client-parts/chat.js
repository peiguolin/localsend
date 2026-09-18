/* 消息分片（门面）：本身不含逻辑，仅装配拆分后的子片。
 *   chat-bus     内部总线（app._chat，子片间共享函数/状态）
 *   chat-render  消息 DOM / 内容高亮 / 引用 / 置顶 / 灯箱 / 时间分隔线
 *   chat-social  表情回应 / 已读回执 / 历史分页懒加载
 *   chat-compose 收消息编排 / 机器人流式气泡 / 发送 / 右键菜单（引用·复制·翻译·置顶·撤回）
 * 浏览器：index.html 按 总线→渲染→社交→发送 的顺序 <script> 加载，本文件为空壳；
 * Node（冒烟测试）：本文件按同序 require 各子片。
 * 对外契约不变：各子片仍把 renderXMsg/isOwnMessage/clearQuote 等挂到 window.chatApp(app.*)。 */
(function () {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    require('./chat-bus.js');
    require('./chat-render.js');
    require('./chat-social.js');
    require('./chat-compose.js');
  }
})();
