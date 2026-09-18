/* chat 子模块内部总线：在拆出的渲染/历史/社交/发送/流式各片之间共享函数与可变状态。
 * 只是重构用的内部命名空间，不改变对外的 window.chatApp(app.*) 契约（其它分片与冒烟测试仍只用 app.*）。
 * 双通道加载：Node 由 client.js 先 require；浏览器由 <script> 先于其它 chat-* 加载。 */
(function () {
  'use strict';
  const app = window.chatApp;
  // 各子片把内部函数/状态挂到 C（同一引用），相互经 C.* 调用
  app._chat = app._chat || {};
  // 历史分页前插模式（由 social 片在加载更早消息时短暂置位，render 的插入逻辑读取）
  if (app._chat.historyPrepend === undefined) app._chat.historyPrepend = false;
})();
