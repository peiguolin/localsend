/* call 子模块内部总线：在拆出的 UI/媒体/会话三片之间共享函数与可变状态。
 * 只是重构用的内部命名空间（app._call），不改变对外 window.chatApp 的契约。
 * 双通道加载：Node 由 call.js 门面先 require；浏览器由 <script> 先于其它 call-* 加载。 */
(function () {
  'use strict';
  const app = window.chatApp;
  app._call = app._call || {};
  const K = app._call;
  // 跨片共享的可变运行态（媒体片维护，会话片收尾时清理）
  K.speakerAnalysers = K.speakerAnalysers || new Map(); // peerId -> {ctx, src, analyser, data}
  K.hiddenRemoteVideos = K.hiddenRemoteVideos || new Set(); // 本地隐藏的远端视频（仅本地生效）
  K.SPEAKER_THRESHOLD = 8; // 说话人检测音量阈值（RMS）
  K.RTC_CONFIG = K.RTC_CONFIG || {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
})();
