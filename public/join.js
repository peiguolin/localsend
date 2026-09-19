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
  const loginForm = document.getElementById('loginForm');
  const applyForm = document.getElementById('applyForm');
  const loginMsg = document.getElementById('loginMsg');
  const applyMsg = document.getElementById('applyMsg');
  const loginBtn = document.getElementById('loginBtn');
  const applyBtn = document.getElementById('applyBtn');

  function showTab(which) {
    const login = which === 'login';
    tabLogin.classList.toggle('active', login);
    tabApply.classList.toggle('active', !login);
    loginForm.hidden = !login;
    applyForm.hidden = login;
    loginMsg.className = 'auth-msg';
    applyMsg.className = 'auth-msg';
  }
  tabLogin.addEventListener('click', () => showTab('login'));
  tabApply.addEventListener('click', () => showTab('apply'));

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
})();
