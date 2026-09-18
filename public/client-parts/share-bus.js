/* share 子模块内部总线：共享可变状态、DOM 句柄与小工具。
 * 只是重构用的内部命名空间（window.chatApp._share），不改变对外契约。
 * 双通道加载：Node 由 share.js 门面先 require；浏览器由 <script> 先于其它 share-* 加载。 */
(function () {
  'use strict';
  if (!window.chatApp) return;
  const app = window.chatApp;
  app._share = app._share || {};
  const S = app._share;
  const { escapeHtml, fmtSize } = app.utils;

  // ---------- 跨片共享状态 ----------
  S.shares = S.shares || [];                 // 服务器推送的共享列表
  S.myShare = S.myShare || null;             // { id, name, dirHandle, canWrite, password }
  S.tokens = S.tokens || new Map();          // shareId -> 访问 token
  S.current = S.current || null;             // 正在浏览的 { share, path:[] }
  S.pendingPwdShare = S.pendingPwdShare || null;
  S.fsSupported = ('showDirectoryPicker' in window);

  // ---------- DOM 句柄（子片统一从这里取，避免重复 getElementById） ----------
  const $ = (id) => document.getElementById(id);
  S.el = S.el || {};
  Object.assign(S.el, {
    tabChat: $('tabChat'), tabShare: $('tabShare'), chatMain: $('chatMain'),
    inputbar: document.querySelector('.inputbar'), shareView: $('shareView'),
    shareHome: $('shareHome'), shareBrowser: $('shareBrowser'),
    createShareBtn: $('createShareBtn'), myShareBox: $('myShareBox'),
    shareList: $('shareList'), shareEmpty: $('shareEmpty'), shareHomeHint: $('shareHomeHint'),
    browserBackBtn: $('browserBackBtn'), browserRefreshBtn: $('browserRefreshBtn'),
    breadcrumb: $('breadcrumb'), browserMeta: $('browserMeta'), browserRows: $('browserRows'),
    browserEmpty: $('browserEmpty'), browserLoading: $('browserLoading'),
    shareUploadBtn: $('shareUploadBtn'), shareUploadInput: $('shareUploadInput'),
    shareBrowserHint: $('shareBrowserHint'),
    createShareModal: $('createShareModal'),
    csName: $('csName'), csPassword: $('csPassword'), csWritable: $('csWritable'),
    csTip: $('csTip'), csConfirm: $('csConfirm'), csCancel: $('csCancel'),
    pwdModal: $('pwdModal'), pwdTitle: $('pwdTitle'), pwdInput: $('pwdInput'),
    pwdError: $('pwdError'), pwdConfirm: $('pwdConfirm'), pwdCancel: $('pwdCancel'),
    manageShareModal: $('manageShareModal'),
    msName: $('msName'), msPassword: $('msPassword'), msClearPassword: $('msClearPassword'),
    msWritable: $('msWritable'), msTip: $('msTip'), msConfirm: $('msConfirm'), msCancel: $('msCancel'),
    dlManager: $('dlManager'), dlList: $('dlList'), dlEmpty: $('dlEmpty')
  });

  // ---------- 小工具 ----------
  S.ICON_DIR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  S.ICON_FILE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';

  S.fmtDate = function (ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  S.setHint = function (el, text, cls) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'upload-hint' + (text ? ' show' : '') + (cls ? ' ' + cls : '');
  };

  S.openModal = (m) => { if (m) m.hidden = false; };
  S.closeModal = (m) => { if (m) m.hidden = true; };

  S.escapeHtml = escapeHtml;
  S.fmtSize = fmtSize;
})();
