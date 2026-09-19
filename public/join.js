/* 登录 / 申请加入页（join.html）：POST /api/join 申请、POST /api/login 登录。
 * 登录成功把会话 token 存入 localStorage（client.js 握手时带上），并跳回首页。 */
(function () {
  'use strict';

  const TOKEN_KEY = 'localsend-session-token';

  function setMsg(el, text, ok) {
    el.textContent = text || '';
    el.className = 'auth-msg show ' + (ok ? 'ok' : 'err');
  }

  function saveToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (_) { /* ignore */ }
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    let j = null;
    try { j = await res.json(); } catch (_) { /* ignore */ }
    return { status: res.status, body: j || {} };
  }

  const tabLogin = document.getElementById('tabLogin');
  const tabApply = document.getElementById('tabApply');
  const tabChange = document.getElementById('tabChange');
  const loginForm = document.getElementById('loginForm');
  const applyForm = document.getElementById('applyForm');
  const changeForm = document.getElementById('changeForm');
  const loginMsg = document.getElementById('loginMsg');
  const applyMsg = document.getElementById('applyMsg');
  const changeMsg = document.getElementById('changeMsg');
  const loginBtn = document.getElementById('loginBtn');
  const applyBtn = document.getElementById('applyBtn');
  const changeBtn = document.getElementById('changeBtn');

  function showTab(which) {
    const login = which === 'login';
    const apply = which === 'apply';
    const change = which === 'change';
    tabLogin.classList.toggle('active', login);
    tabApply.classList.toggle('active', apply);
    tabChange.classList.toggle('active', change);
    loginForm.hidden = !login;
    applyForm.hidden = !apply;
    changeForm.hidden = !change;
    loginMsg.className = 'auth-msg';
    applyMsg.className = 'auth-msg';
    changeMsg.className = 'auth-msg';
  }
  tabLogin.addEventListener('click', () => showTab('login'));
  tabApply.addEventListener('click', () => showTab('apply'));
  tabChange.addEventListener('click', () => showTab('change'));

  // 初始状态：非邀请模式 → 回首页；已登录 → 回首页
  fetch('/api/auth/status').then((r) => r.json()).then((s) => {
    if (s && s.mode !== 'invite') { location.href = '/'; return; }
    if (s && s.authed) { location.href = '/'; }
  }).catch(() => { /* 网络异常忽略，留在本页 */ });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginBtn.disabled = true;
    loginMsg.className = 'auth-msg';
    const r = await post('/api/login', {
      username: loginUser.value.trim(),
      password: loginPass.value
    }).catch(() => ({ status: 0, body: { error: '网络错误，请重试' } }));
    loginBtn.disabled = false;
    if (r.status === 200 && r.body && r.body.token) {
      saveToken(r.body.token);
      setMsg(loginMsg, '登录成功，正在进入…', true);
      setTimeout(() => { location.href = '/'; }, 300);
    } else {
      setMsg(loginMsg, (r.body && r.body.error) || '登录失败');
    }
  });

  applyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    applyBtn.disabled = true;
    applyMsg.className = 'auth-msg';
    const r = await post('/api/join', {
      code: applyCode.value.trim(),
      username: applyUser.value.trim(),
      nickname: applyNick.value.trim(),
      password: applyPass.value
    }).catch(() => ({ status: 0, body: { error: '网络错误，请重试' } }));
    applyBtn.disabled = false;
    if (r.status === 200 && r.body && r.body.ok) {
      setMsg(applyMsg, r.body.message || '申请已提交，等待管理员审批', true);
      applyForm.reset();
      setTimeout(() => showTab('login'), 1200);
    } else {
      setMsg(applyMsg, (r.body && r.body.error) || '提交失败');
    }
  });

  changeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const np = changeNew.value;
    if (np !== changeNew2.value) {
      setMsg(changeMsg, '两次输入的新密码不一致');
      return;
    }
    changeBtn.disabled = true;
    changeMsg.className = 'auth-msg';
    const r = await post('/api/password/change', {
      username: changeUser.value.trim(),
      oldPassword: changeOld.value,
      newPassword: np
    }).catch(() => ({ status: 0, body: { error: '网络错误，请重试' } }));
    changeBtn.disabled = false;
    if (r.status === 200 && r.body && r.body.ok) {
      setMsg(changeMsg, r.body.message || '密码已修改', true);
      changeForm.reset();
      setTimeout(() => showTab('login'), 1500);
    } else {
      setMsg(changeMsg, (r.body && r.body.error) || '修改失败');
    }
  });
})();
