/* 成员分片：在线成员列表渲染 / 多选 / 群呼。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之后加载。
 * 跨模块依赖：call 的 startCall、壳的 setHint —— 经 app.* 事件期调用。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const socket = app.socket;
  const state = app.state;

  // ---------- DOM 引用 ----------
  const memberList = document.getElementById('memberList');
  const onlineCount = document.getElementById('onlineCount');
  const callActionBar = document.getElementById('callActionBar');
  const callSelectedBtn = document.getElementById('callSelectedBtn');
  const callSelectionClearBtn = document.getElementById('callSelectionClearBtn');
  const groupCallBtn = document.getElementById('groupCallBtn');

  // ---------- 成员列表 ----------
  // state.selectedMembers / state.currentMembers 见 state.js

  function updateCallActionBar() {
    const n = state.selectedMembers.size;
    if (n > 0) {
      callActionBar.hidden = false;
      callSelectedBtn.textContent = `发起通话 (${n})`;
    } else {
      callActionBar.hidden = true;
    }
  }

  function renderMembers(members) {
    state.currentMembers = members;
    onlineCount.textContent = members.length;
    memberList.innerHTML = '';
    // 清理已离线的选中项
    const liveIds = new Set(members.map((m) => m && m.id).filter(Boolean));
    for (const sid of Array.from(state.selectedMembers)) {
      if (!liveIds.has(sid)) state.selectedMembers.delete(sid);
    }
    updateCallActionBar();
    if (!members.length) {
      const li = document.createElement('li');
      li.className = 'empty-members';
      li.textContent = '暂无在线成员';
      memberList.appendChild(li);
      return;
    }
    members.forEach((m) => {
      const name = (m && m.nickname) || String(m);
      const id = m && m.id;
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'member-dot';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = name;
      nameSpan.style.overflow = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.whiteSpace = 'nowrap';
      li.appendChild(dot);
      li.appendChild(nameSpan);
      if (name === state.myNickname && id === state.myId) {
        const me = document.createElement('span');
        me.className = 'member-me';
        me.textContent = '我';
        li.appendChild(me);
      } else if (id && id !== state.myId) {
        // 点击名字多选（用于群呼）；hover 电话图标快速单呼
        li.classList.add('selectable');
        li.title = '点击名字可多选，然后发起通话';
        if (state.selectedMembers.has(id)) li.classList.add('selected');
        li.addEventListener('click', () => {
          if (state.selectedMembers.has(id)) state.selectedMembers.delete(id);
          else state.selectedMembers.add(id);
          renderMembers(members);
        });
        // 语音通话按钮（快速单呼）
        const callBtn = document.createElement('button');
        callBtn.type = 'button';
        callBtn.className = 'member-call';
        callBtn.title = `语音呼叫 ${name}`;
        callBtn.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
        callBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          app.startCall([{ id, nickname: name }]);
        });
        li.appendChild(callBtn);
      }
      memberList.appendChild(li);
    });
  }

  // 群呼：呼叫所有在线成员（不含自己）
  function groupCall() {
    const list = state.currentMembers.filter((m) => m && m.id && m.id !== state.myId);
    if (!list.length) {
      app.setHint('当前没有可呼叫的在线成员', '');
      return;
    }
    app.startCall(list);
  }

  // 多选呼叫：呼叫已选中的成员
  function callSelected() {
    const list = state.currentMembers.filter((m) => m && state.selectedMembers.has(m.id));
    if (!list.length) return;
    app.startCall(list);
    state.selectedMembers.clear();
    updateCallActionBar();
    renderMembers(state.currentMembers);
  }

  socket.on('members_update', (members) => {
    state.latestMembers = Array.isArray(members) ? members : [];
    renderMembers(members);
  });

  // 按钮绑定
  groupCallBtn.addEventListener('click', groupCall);
  callSelectedBtn.addEventListener('click', callSelected);
  callSelectionClearBtn.addEventListener('click', () => {
    state.selectedMembers.clear();
    updateCallActionBar();
    renderMembers(state.currentMembers);
  });

  // 暴露给其他分片（壳 welcome 编排 / 通话弹窗按钮等）
  Object.assign(app, {
    renderMembers,
    updateCallActionBar
  });
})();
