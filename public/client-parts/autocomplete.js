/* @ 自动补全分片：输入 @ 触发成员补全，键盘/鼠标选择。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之后加载。
 * 依赖：state（latestMembers / myNickname / ac*）与 msgInput DOM。
 * 键盘导航由 chat 分片的 msgInput keydown 处理器调用本分片的 acMove/acSelect/closeAutocomplete。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const state = app.state;
  const { escapeHtml } = app.utils;

  // ---------- DOM 引用 ----------
  const msgInput = document.getElementById('msgInput');

  // 补全浮层
  const acBox = document.createElement('div');
  acBox.className = 'ac-box';
  acBox.hidden = true;
  document.querySelector('.inputbar').appendChild(acBox);
  // state.acOpen / state.acItems / state.acIndex / state.acTokenStart 见 state.js

  function closeAutocomplete() {
    state.acOpen = false;
    acBox.hidden = true;
    state.acItems = [];
    state.acTokenStart = -1;
  }

  // 光标前最近一个 @token
  function acDetect() {
    const pos = msgInput.selectionStart;
    const before = msgInput.value.slice(0, pos);
    const m = before.match(/@([^\s@]{0,20})$/);
    if (!m) return null;
    return { start: pos - m[0].length, keyword: m[1] };
  }

  function acRefresh() {
    const hit = acDetect();
    if (!hit) {
      closeAutocomplete();
      return;
    }
    const kw = hit.keyword.toLowerCase();
    state.acItems = state.latestMembers
      .filter((m) => (m.nickname || m) !== state.myNickname)
      .map((m) => m.nickname || m)
      .filter((nick) => !kw || nick.toLowerCase().includes(kw))
      .slice(0, 8);
    if (!state.acItems.length) {
      closeAutocomplete();
      return;
    }
    state.acTokenStart = hit.start;
    state.acOpen = true;
    state.acIndex = 0;
    acBox.innerHTML = state.acItems.map((nick, i) =>
      `<div class="ac-item${i === state.acIndex ? ' active' : ''}" data-i="${i}">${escapeHtml(nick)}</div>`
    ).join('');
    acBox.hidden = false;
    acBox.querySelectorAll('.ac-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 保持输入框焦点
        state.acIndex = Number(el.dataset.i);
        acSelect();
      });
    });
  }

  function acMove(delta) {
    state.acIndex = (state.acIndex + delta + state.acItems.length) % state.acItems.length;
    acBox.querySelectorAll('.ac-item').forEach((el, i) => el.classList.toggle('active', i === state.acIndex));
  }

  function acSelect() {
    const nick = state.acItems[state.acIndex];
    if (!nick) return;
    const pos = msgInput.selectionStart;
    msgInput.value = msgInput.value.slice(0, state.acTokenStart) + '@' + nick + ' ' + msgInput.value.slice(pos);
    const caret = state.acTokenStart + nick.length + 2;
    msgInput.setSelectionRange(caret, caret);
    closeAutocomplete();
    msgInput.focus();
  }

  msgInput.addEventListener('input', acRefresh);
  msgInput.addEventListener('click', acRefresh);
  msgInput.addEventListener('blur', () => setTimeout(closeAutocomplete, 150));

  // 暴露给其他分片（chat 的 keydown 导航 + sendMessage 收起）
  Object.assign(app, {
    closeAutocomplete,
    acMove,
    acSelect
  });
})();
