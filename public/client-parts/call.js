/* 通话分片（门面）：本身不含逻辑，仅装配拆分后的子片。
 *   call-bus     内部总线（app._call，子片间共享 DOM 句柄、可变集合、RTC 配置）
 *   call-ui      弹窗界面 / 计时 / 振铃 / 成员 chips / 视频网格 tile / 说话人检测
 *   call-media   RTCPeerConnection 管理 / 摄像头与前后切换 / 重协商 / 设备采集 / 本地预览 / 收尾
 *   call-session 发起·接听·拒绝·静音·挂断 + 全部 call_ 与 rtc_ 前缀信令监听 + 按钮绑定 + 对外导出
 * 浏览器：index.html 按 总线 -> UI -> 媒体 -> 会话 的顺序 <script> 加载，本文件为空壳；
 * Node（冒烟测试）：本文件按同序 require 各子片。对外契约（app.startCall/callTargets 等）不变。 */
(function () {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    require('./call-bus.js');
    require('./call-ui.js');
    require('./call-media.js');
    require('./call-session.js');
  }
})();
