/* 文件夹共享（门面）：本身不含逻辑，仅装配拆分后的子片。
 *   share-bus        内部总线（app._share，共享状态/DOM 句柄/小工具）
 *   share-downloads  OPFS 分段存储 + 下载管理器接线 + 下载列表 UI
 *   share-proxy      共享者本地文件系统代理（share_fs：list/read/write，Range push/pull）
 *   share-core       Tab 注册、共享列表、创建/管理/取消、句柄恢复、密码进入
 *   share-browser    目录浏览、面包屑、文件下载、上传到共享目录
 * 浏览器：index.html 按 总线→下载→代理→核心→浏览器 的顺序 <script> 加载，本文件为空壳；
 * Node（冒烟测试）：本文件按同序 require 各子片。对外契约（app.switchView/registerTab）不变。 */
(function () {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    require('./client-parts/share-bus.js');
    require('./client-parts/share-downloads.js');
    require('./client-parts/share-proxy.js');
    require('./client-parts/share-core.js');
    require('./client-parts/share-browser.js');
  }
})();
