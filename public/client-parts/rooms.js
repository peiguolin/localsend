/* 群聊房间分片：房间列表 / 切换 / 历史 / 未读角标 / 标题栏 / 拉起群聊弹窗 / 群生命周期。
 * 双通道加载：Node（冒烟测试）由 client.js require；浏览器由 <script> 在 client.js 之后加载。
 * 跨模块依赖：chat 的 render*Msg，壳的 appendMsg/scrollToBottom/setHint/closeDrawer —— 均经 app.* 事件期调用。 */
(function () {
  'use strict';

  const app = window.chatApp;
  const socket = app.socket;
  const state = app.state;
  const { escapeHtml } = app.utils;

  // ---------- DOM 引用 ----------
  const chatArea = document.getElementById('chatArea');
  const mobileRoomList = document.getElementById('mobileRoomList');
  const roomClearBtn = document.getElementById('roomClearBtn');
  const groupModal = document.getElementById('groupModal');
  const groupNameInput = document.getElementById('groupNameInput');
  const groupSelList = document.getElementById('groupSelList');
  const groupSelCount = document.getElementById('groupSelCount');
  const groupConfirm = document.getElementById('groupConfirm');
  const groupTip = document.getElementById('groupTip');
  const roomCreateBtn = document.getElementById('roomCreateBtn');
  const groupPickList = document.getElementById('groupPickList');
  // 机器人设置（宿主机或房主）
  const roomBotBtn = document.getElementById('roomBotBtn');
  const botModal = document.getElementById('botModal');
  const botEnableSel = document.getElementById('botEnableSel');
  const botPromptInput = document.getElementById('botPromptInput');
  const botCfgTip = document.getElementById('botCfgTip');
  const botCfgCancel = document.getElementById('botCfgCancel');
  const botCfgSave = document.getElementById('botCfgSave');

  // ==================== 群聊房间 ====================

  function roomDisplayName(room) {
    return room && room.name ? room.name : '群聊';
  }

  // 渲染单个房间项（共用：桌面 sidebar 的完整项 + 移动底部栏的紧凑项）
  function createRoomItemEl(r) {
    const li = document.createElement('li');
    li.className = 'room-item' + (state.currentRoom === r.id ? ' active' : '');
    li.dataset.room = r.id;
    const unread = state.roomUnread.get(r.id) || 0;
    const membersText = (r.members || []).map((m) => m.nickname).join('、');
    li.innerHTML =
      `<span class="room-name">${escapeHtml(roomDisplayName(r))}</span>` +
      `<span class="room-members" title="${escapeHtml(membersText)}">${escapeHtml((r.members || []).length + '人')}</span>` +
      `<span class="room-unread" data-role="unread"${unread ? '' : ' hidden'}>${unread}</span>` +
      `<button class="room-leave" data-role="leave" title="退出/解散群聊">✕</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="leave"]')) {
        e.stopPropagation();
        leaveRoom(r.id);
        return;
      }
      switchRoom(r.id);
    });
    return li;
  }

  // 移动底部栏的紧凑房间项（只有名称 + 未读）
  function createMobileRoomItemEl(r) {
    const li = document.createElement('li');
    li.className = 'mobile-room-item' + (state.currentRoom === r.id ? ' active' : '');
    li.dataset.room = r.id;
    const unread = state.roomUnread.get(r.id) || 0;
    li.innerHTML =
      `<span>${escapeHtml(roomDisplayName(r))}</span>` +
      (unread ? `<span class="mobile-room-unread" data-role="unread">${unread}</span>` : '');
    li.addEventListener('click', () => switchRoom(r.id));
    return li;
  }

  // 渲染右侧房间列表（公共房 + 我加入的群聊房）+ 移动底部标签栏
  function renderRoomList() {
    const list = document.getElementById('roomList');
    const roomMain = document.getElementById('roomMain');
    // 公共房始终第一项，active 态由 state.currentRoom 决定
    if (roomMain) roomMain.classList.toggle('active', state.currentRoom === 'main');
    // 移除旧群聊项（保留公共房）
    const old = list.querySelectorAll('.room-item[data-room^="g"]');
    old.forEach((el) => el.remove());
    for (const r of state.myRooms) {
      list.appendChild(createRoomItemEl(r));
    }
    // 移动底部标签栏：公共房 + 群聊房
    if (mobileRoomList) {
      mobileRoomList.innerHTML = '';
      const mainItem = document.createElement('li');
      mainItem.className = 'mobile-room-item' + (state.currentRoom === 'main' ? ' active' : '');
      mainItem.dataset.room = 'main';
      const mainUnread = state.roomUnread.get('main') || 0;
      mainItem.innerHTML = `<span>💬 公共房</span>` + (mainUnread ? `<span class="mobile-room-unread" data-role="unread">${mainUnread}</span>` : '');
      mainItem.addEventListener('click', () => switchRoom('main'));
      mobileRoomList.appendChild(mainItem);
      for (const r of state.myRooms) mobileRoomList.appendChild(createMobileRoomItemEl(r));
    }
    updateRoomUnreadBadge(state.currentRoom);
  }

  // 房间未读角标更新（桌面列表 + 移动底部栏 + 顶部 tab 红点联动）
  function updateRoomUnreadBadge(room) {
    const list = document.getElementById('roomList');
    const item = list.querySelector(`.room-item[data-room="${CSS.escape(room)}"]`);
    const badge = item && item.querySelector('[data-role="unread"]');
    const n = state.roomUnread.get(room) || 0;
    if (badge) {
      badge.textContent = n;
      badge.hidden = n === 0;
    }
    // 移动底部栏角标
    if (mobileRoomList) {
      const mItem = mobileRoomList.querySelector(`.mobile-room-item[data-room="${CSS.escape(room)}"]`);
      const mBadge = mItem && mItem.querySelector('[data-role="unread"]');
      if (mItem) {
        if (n && mBadge) mBadge.textContent = n;
        else if (n && !mBadge) {
          const b = document.createElement('span');
          b.className = 'mobile-room-unread';
          b.dataset.role = 'unread';
          b.textContent = n;
          mItem.appendChild(b);
        } else if (!n && mBadge) mBadge.remove();
      }
    }
  }

  // 切换房间：清空聊天区 → 加载该房间历史 → 更新标题/输入区/房间列表
  function switchRoom(room) {
    if (room === state.currentRoom) return;
    state.currentRoom = room;
    state.roomUnread.set(room, 0);
    chatArea.innerHTML = '';
    state.msgStore.clear();
    app.initHistoryState(); // 重置历史分页状态，防串房
    // 更新房间列表 active
    document.querySelectorAll('.room-item').forEach((el) => el.classList.toggle('active', el.dataset.room === room));
    if (mobileRoomList) {
      mobileRoomList.querySelectorAll('.mobile-room-item').forEach((el) => el.classList.toggle('active', el.dataset.room === room));
    }
    updateRoomUnreadBadge(room);
    updateRoomTitlebar();
    app.closeDrawer(); // 移动端：切房后收起抽屉
    // 加载该房间历史
    socket.emit('room_history', { room }, (res) => {
      if (res && res.ok) {
        const sep = document.createElement('div');
        sep.className = 'msg system';
        sep.innerHTML = `<div class="msg-bubble">—— ${escapeHtml(room === 'main' ? '公共房' : roomDisplayName(state.myRooms.find((r) => r.id === room)))} 最近 ${res.history.length} 条消息 ——</div>`;
        app.appendMsg(sep);
        res.history.forEach((m) => {
          if (!m || m.recalled) return;
          if (m.id) state.msgStore.set(m.id, m);
          if (m.type === 'image') app.renderImageMsg(m);
          else if (m.type === 'file') app.renderFileMsg(m);
          else app.renderTextMsg(m);
        });
        const sepEnd = document.createElement('div');
        sepEnd.className = 'msg system';
        sepEnd.innerHTML = `<div class="msg-bubble">—— 历史消息结束 ——</div>`;
        app.appendMsg(sepEnd);
        app.scrollToBottom(false);
        app.initHistoryState(res.history); // 初始化该房间的历史分页起点
      }
    });
  }

  // 顶部标题栏：显示当前房间名（切换房间时刷新）；房主/宿主机显示「清空记录」；宿主机/房主显示「🤖 机器人」
  function updateRoomTitlebar() {
    let title = '公共房';
    let hint = '所有人都在这里聊天';
    let canClear = false;
    let canBot = !!app.isLocal; // 宿主机：任意房间可设机器人
    if (state.currentRoom !== 'main') {
      const r = state.myRooms.find((x) => x.id === state.currentRoom);
      title = roomDisplayName(r);
      hint = r ? (r.members || []).map((m) => m.nickname).join('、') : '';
      canClear = state.isLocalHost || !!(r && r.ownerClientId && r.ownerClientId === state.myClientId);
      if (!canBot) canBot = !!(r && r.ownerClientId && r.ownerClientId === state.myClientId); // 房主也可设
    }
    const bar = document.querySelector('.room-titlebar .rt-name');
    if (bar) bar.textContent = title;
    const hintEl = document.getElementById('roomTitleHint');
    if (hintEl) hintEl.textContent = hint;
    roomClearBtn.hidden = !canClear;
    roomBotBtn.hidden = !canBot;
  }

  // ---------- 房间级机器人覆盖（宿主机或房主） ----------
  function openBotConfigModal() {
    botCfgTip.textContent = '';
    socket.emit('room_bot_config', { room: state.currentRoom, get: true }, (res) => {
      const enabled = res && res.ok ? res.enabled : null;
      const prompt = res && res.ok ? (res.prompt || '') : '';
      botEnableSel.value = enabled === null || enabled === undefined ? '' : (enabled ? '1' : '0');
      botPromptInput.value = prompt;
      botModal.hidden = false;
    });
  }

  roomBotBtn.addEventListener('click', openBotConfigModal);
  botCfgCancel.addEventListener('click', () => { botModal.hidden = true; });
  botModal.addEventListener('click', (e) => {
    if (e.target === botModal || e.target.classList.contains('modal-backdrop')) botModal.hidden = true;
  });
  botCfgSave.addEventListener('click', () => {
    const v = botEnableSel.value;
    const enabled = v === '' ? null : v === '1';
    const prompt = botPromptInput.value.trim();
    socket.emit('room_bot_config', { room: state.currentRoom, enabled, prompt }, (res) => {
      if (res && res.ok) {
        botModal.hidden = true;
        app.setHint(
          enabled === null ? '本房间机器人已恢复继承全局设置' : (enabled ? '本房间机器人已开启' : '本房间机器人已关闭'),
          'success'
        );
      } else {
        botCfgTip.textContent = (res && res.error) || '保存失败';
      }
    });
  });

  // 清空本房间聊天记录（房主或宿主机；二次确认）
  roomClearBtn.addEventListener('click', () => {
    const r = state.myRooms.find((x) => x.id === state.currentRoom);
    const label = r ? roomDisplayName(r) : '本房间';
    if (!confirm(`确定清空「${label}」的全部聊天记录吗？\n此操作不可恢复（文件本体保留在宿主机）。`)) return;
    socket.emit('room_history_clear', { room: state.currentRoom }, (res) => {
      if (!res || !res.ok) app.setHint((res && res.error) || '清空失败', 'error');
    });
  });

  // 房间历史被清空（房主或宿主机操作后广播）→ 正在查看该房间则清空本地视图
  socket.on('room_cleared', (data) => {
    if (!data || data.room !== state.currentRoom) return;
    chatArea.innerHTML = '';
    state.msgStore.clear();
  });

  // 公共房历史被清空（宿主机操作后广播）
  socket.on('history_cleared', () => {
    if (state.currentRoom !== 'main') return;
    chatArea.innerHTML = '';
    state.msgStore.clear();
  });

  // 退出/解散群聊
  function leaveRoom(room) {
    const r = state.myRooms.find((x) => x.id === room);
    const label = r ? roomDisplayName(r) : '该群聊';
    if (!confirm(`确定退出「${label}」吗？\n创建者退出将解散该群聊（历史消息保留在服务器）`)) return;
    socket.emit('group_leave', { room }, (res) => {
      if (res && res.ok) {
        if (res.disbanded) {
          removeRoomFromList(room);
        } else {
          removeRoomFromList(room);
        }
        if (state.currentRoom === room) switchRoom('main');
      } else {
        app.setHint((res && res.error) || '操作失败', 'error');
      }
    });
  }

  function removeRoomFromList(room) {
    state.myRooms = state.myRooms.filter((r) => r.id !== room);
    state.roomUnread.delete(room);
    renderRoomList();
  }

  // 收到群聊创建通知（被拉的人）
  socket.on('group_invited', (data) => {
    const room = data && data.room;
    if (!room) return;
    if (!state.myRooms.some((r) => r.id === room.id)) {
      state.myRooms.push(room);
      renderRoomList();
      app.setHint(`你被拉入了群聊「${roomDisplayName(room)}」`, 'success');
    }
  });

  // 自己创建的群聊
  socket.on('group_created', (data) => {
    const room = data && data.room;
    if (!room) return;
    if (!state.myRooms.some((r) => r.id === room.id)) {
      state.myRooms.push(room);
      renderRoomList();
    }
    app.setHint(`群聊「${roomDisplayName(room)}」创建成功`, 'success');
  });

  // 群聊被解散 / 自己被移出
  socket.on('group_disbanded', (data) => {
    const room = data && data.room;
    removeRoomFromList(room);
    if (state.currentRoom === room) switchRoom('main');
    app.setHint('群聊已解散', '');
  });

  socket.on('group_left', (data) => {
    const room = data && data.room;
    removeRoomFromList(room);
    if (state.currentRoom === room) switchRoom('main');
  });

  // 群聊改名（服务端广播系统消息；列表名用最新数据刷新）
  socket.on('group_renamed', (data) => {
    const room = data && data.room;
    if (!room) return;
    const idx = state.myRooms.findIndex((r) => r.id === room.id);
    if (idx >= 0) state.myRooms[idx] = room;
    renderRoomList();
    if (state.currentRoom === room.id) updateRoomTitlebar();
  });

  // ---------- 拉起群聊弹窗 ----------
  // state.groupSel: socketId -> nickname（与状态共享同一 Map）

  function openGroupModal() {
    // 把当前已在成员列表里勾选的人带入群聊选择（state.selectedMembers 是通话多选的同一批）
    state.groupSel = new Map();
    for (const m of state.currentMembers) {
      if (m && state.selectedMembers.has(m.id)) state.groupSel.set(m.id, m.nickname);
    }
    renderGroupSel();
    groupNameInput.value = '';
    groupTip.textContent = state.groupSel.size
      ? `已带入 ${state.groupSel.size} 位已选成员，可移除或调整`
      : '从在线成员列表里点击添加，再点「创建群聊」';
    groupModal.hidden = false;
  }

  // 弹窗内在线成员（排除自己与已选），点击添加进群聊
  function renderGroupPick() {
    groupPickList.innerHTML = '';
    for (const m of state.currentMembers) {
      if (!m || m.id === state.myId) continue;
      if (state.groupSel.has(m.id)) continue;
      const chip = document.createElement('span');
      chip.className = 'group-pick-chip';
      chip.textContent = m.nickname;
      chip.addEventListener('click', () => {
        state.groupSel.set(m.id, m.nickname);
        renderGroupSel();
        renderGroupPick();
      });
      groupPickList.appendChild(chip);
    }
    if (!groupPickList.children.length) {
      const empty = document.createElement('span');
      empty.className = 'group-pick-empty';
      empty.textContent = '没有可添加的成员';
      groupPickList.appendChild(empty);
    }
  }

  function renderGroupSel() {
    groupSelList.innerHTML = '';
    groupSelCount.textContent = state.groupSel.size;
    state.groupSel.forEach((nick, sid) => {
      const chip = document.createElement('span');
      chip.className = 'group-sel-chip';
      chip.innerHTML = `${escapeHtml(nick)} <span class="chip-remove" data-sid="${sid}">✕</span>`;
      chip.querySelector('.chip-remove').addEventListener('click', () => {
        state.groupSel.delete(sid);
        renderGroupSel();
        renderGroupPick();
      });
      groupSelList.appendChild(chip);
    });
    groupConfirm.disabled = state.groupSel.size === 0;
    renderGroupPick();
  }

  roomCreateBtn.addEventListener('click', openGroupModal);
  document.getElementById('groupCancel').addEventListener('click', () => { groupModal.hidden = true; });
  groupModal.addEventListener('click', (e) => {
    if (e.target === groupModal || e.target.classList.contains('modal-backdrop')) groupModal.hidden = true;
  });
  groupConfirm.addEventListener('click', () => {
    if (!state.groupSel.size) return;
    const targetIds = Array.from(state.groupSel.keys());
    const name = groupNameInput.value.trim();
    socket.emit('group_create', { targetIds, name: name || undefined }, (res) => {
      if (res && res.ok) {
        groupModal.hidden = true;
      } else {
        groupTip.textContent = (res && res.error) || '创建失败';
      }
    });
  });

  // 公共房（静态元素）一次性绑定点击切换；renderRoomList 只负责 active 态
  const roomMainEl = document.getElementById('roomMain');
  if (roomMainEl && !roomMainEl._roomClickBound) {
    roomMainEl.addEventListener('click', () => switchRoom('main'));
    roomMainEl._roomClickBound = true;
  }

  // 页面加载后刷新标题栏
  window.addEventListener('load', updateRoomTitlebar);

  // 暴露给其他分片（chat 未读角标、壳 welcome 编排等）
  Object.assign(app, {
    renderRoomList,
    switchRoom,
    updateRoomUnreadBadge,
    updateRoomTitlebar
  });
})();
