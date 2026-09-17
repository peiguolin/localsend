/* 客户端纯工具模块：无 DOM / socket 依赖，可独立测试。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之前加载。
 * 挂到 window.chatApp.utils 供 client.js 及全部功能分片复用。 */
(function () {
  'use strict';

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // CJK 占比启发式：超过阈值视为"已是中文"（翻译入口 / 文本分类用）
  function mostlyCJK(text) {
    const chars = String(text || '').replace(/\s+/g, '');
    if (!chars.length) return true;
    let cjk = 0;
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) cjk++;
    }
    return cjk / chars.length > 0.3;
  }

  window.chatApp = window.chatApp || {};
  // @全员判定（与 server 端 chatlog.hasMentionAll 同规则：@所有人/@all/@everyone）
  function hasMentionAll(text) {
    return /@(?:所有人|everyone)(?![\w一-龥])|@all\b/i.test(String(text || ''));
  }

  window.chatApp.utils = Object.assign({}, window.chatApp.utils, {
    pad, fmtTime, fmtSize, escapeHtml, mostlyCJK, hasMentionAll
  });
})();
