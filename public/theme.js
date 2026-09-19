/* 主题初始化（index.html / join.html 共用，须在样式表之前执行，避免首屏闪烁）。
 * 独立成外部文件：配合 CSP script-src 'self'（不放行内联脚本）。 */
(function () {
  'use strict';
  var t = null;
  try { t = localStorage.getItem('localsend-theme'); } catch (e) { /* ignore */ }
  if (t !== 'dark' && t !== 'light') {
    t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
