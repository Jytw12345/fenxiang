'use strict';
// 登录/注册模态框逻辑（首页与管理后台共用）。
// 不再跳转到 auth.html，避免 Supabase 会话导致反复重定向。
(function () {
  const sb = window.sb || null;
  let loginMode = 'login'; // login | register
  const modal = document.getElementById('loginModal');
  const msgEl = () => document.getElementById('loginMsg');

  function setMode() {
    document.getElementById('loginTitle').textContent = loginMode === 'login' ? '登录' : '注册';
    document.getElementById('loginSubmit').textContent = loginMode === 'login' ? '登录' : '注册';
    document.getElementById('loginToggle').textContent = loginMode === 'login' ? '没有账号？去注册' : '已有账号？去登录';
    document.getElementById('loginInviteField').style.display = loginMode === 'register' ? 'block' : 'none';
    msgEl().textContent = '';
  }
  function open() {
    loginMode = 'login'; setMode();
    msgEl().textContent = '';
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPw').value = '';
    document.getElementById('loginInvite').value = '';
    modal.classList.add('show');
    setTimeout(() => { const e = document.getElementById('loginEmail'); if (e) e.focus(); }, 50);
  }
  function close() { modal.classList.remove('show'); }

  async function bootstrap(token, email) {
    if (!sb) return email;
    try {
      const r = await fetch('/api/auth/bootstrap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userToken: token, inviteCode: (document.getElementById('loginInvite').value || '').trim() })
      });
      if (r.ok) { const d = await r.json(); return d.email || email; }
    } catch (e) { /* 后端不可用时仍放行，登录态以后续 /api/auth/me 为准 */ }
    return email;
  }

  async function submit() {
    const email = document.getElementById('loginEmail').value.trim();
    const pw = document.getElementById('loginPw').value;
    const msg = msgEl();
    if (!email || !pw) { msg.textContent = '请填写邮箱和密码'; return; }
    if (loginMode === 'register' && pw.length < 8) { msg.textContent = '密码至少 8 位'; return; }
    const btn = document.getElementById('loginSubmit');
    btn.disabled = true;
    try {
      if (sb) {
        const r = loginMode === 'register'
          ? await sb.auth.signUp({ email, password: pw })
          : await sb.auth.signInWithPassword({ email, password: pw });
        if (r.error) { msg.textContent = r.error.message || '失败'; return; }
        const sess = r.data && r.data.session;
        if (!sess) { msg.textContent = '注册成功，请查收验证邮件后再登录'; return; }
        const realEmail = await bootstrap(sess.access_token, email);
        done(sess.access_token, realEmail);
        return;
      }
      const r = await fetch('/api/auth/' + loginMode, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, password: pw,
          inviteCode: loginMode === 'register' ? (document.getElementById('loginInvite').value || '').trim() : ''
        })
      });
      const d = await r.json();
      if (!r.ok) { msg.textContent = d.message || d.error || '失败'; return; }
      done(d.userToken, d.email);
    } catch (e) { msg.textContent = '网络错误'; }
    finally { btn.disabled = false; }
  }

  function done(token, email) {
    localStorage.setItem('userToken', token);
    localStorage.setItem('userEmail', email || '');
    close();
    if (typeof window.afterLogin === 'function') window.afterLogin(email);
    const t = document.getElementById('toast');
    if (t) { t.textContent = '登录成功'; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); }
  }

  window.openLoginModal = open;
  window.closeLoginModal = close;

  if (modal) {
    document.getElementById('loginSubmit').addEventListener('click', submit);
    document.getElementById('loginToggle').addEventListener('click', (e) => { e.preventDefault(); loginMode = loginMode === 'login' ? 'register' : 'login'; setMode(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  }
  if (!window.ENABLE_WECHAT_LOGIN) { const w = document.getElementById('loginWxSection'); if (w) w.style.display = 'none'; }
})();
