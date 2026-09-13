'use strict';
// 登录/注册模态框逻辑（首页与管理后台共用）。
// 不再跳转到 auth.html，避免 Supabase 会话导致反复重定向。
// 新增：密码显示/隐藏切换、记住密码（本机保存凭据，7 天内自动登录）。
(function () {
  const sb = window.sb || null;
  let loginMode = 'login'; // login | register
  const modal = document.getElementById('loginModal');
  const msgEl = () => document.getElementById('loginMsg');
  // 记住密码：本地保存的凭据（仅本机浏览器，非传输用）
  const SAVED_KEY = 'savedLogin';

  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveCreds(email, pw) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify({ email, password: pw })); } catch (e) { /* 隐私模式忽略 */ }
  }
  function clearCreds() {
    try { localStorage.removeItem(SAVED_KEY); } catch (e) { /* ignore */ }
  }

  function setMode() {
    const isLogin = loginMode === 'login';
    document.getElementById('loginTitle').textContent = isLogin ? '欢迎回来' : '创建账号';
    const sub = document.getElementById('loginSub'); if (sub) sub.textContent = isLogin ? '登录以管理你的安全分享' : '注册一个新账号，加入安全分享';
    document.getElementById('loginSubmit').textContent = isLogin ? '登录' : '注册';
    const tL = document.getElementById('loginTabLogin'), tR = document.getElementById('loginTabReg');
    if (tL) tL.classList.toggle('active', isLogin);
    if (tR) tR.classList.toggle('active', !isLogin);
    document.getElementById('loginInviteField').style.display = isLogin ? 'none' : 'block';
    document.getElementById('loginRealNameField').style.display = isLogin ? 'none' : 'block';
    // 注册模式不展示“记住密码”（注册后本就直接登录）
    const rr = document.querySelector('.remember-row'); if (rr) rr.style.display = isLogin ? 'flex' : 'none';
    msgEl().textContent = '';
  }
  function open() {
    loginMode = 'login'; setMode();
    msgEl().textContent = '';
    // 记住密码：自动回填邮箱/密码并勾选
    const saved = loadSaved();
    document.getElementById('loginEmail').value = saved ? (saved.email || '') : '';
    document.getElementById('loginPw').value = saved ? (saved.password || '') : '';
    const rk = document.getElementById('loginRemember'); if (rk) rk.checked = !!saved;
    document.getElementById('loginInvite').value = '';
    const rnEl = document.getElementById('loginRealName'); if (rnEl) rnEl.value = '';
    modal.classList.add('show');
    setTimeout(() => { const e = document.getElementById('loginEmail'); if (e) e.focus(); }, 50);
  }
  function close() { modal.classList.remove('show'); }

  async function bootstrap(token, email) {
    if (!sb) return { email };
    try {
      const r = await fetch('/api/auth/bootstrap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userToken: token, inviteCode: (document.getElementById('loginInvite').value || '').trim() })
      });
      if (r.ok) {
        const d = await r.json();
        return { email: d.email || email, isSuper: !!d.isSuper, role: d.role || 'member' };
      }
      // bootstrap 失败（如后端未启用 Supabase）：把错误信息抛出去，避免登录成功却进不了后台
      const err = await r.json().catch(() => ({}));
      throw new Error(err.message || '身份同步失败，请检查后端 Supabase 配置');
    } catch (e) {
      // 网络异常仍放行，登录态以后续 /api/auth/me 为准
      if (e.message && e.message.includes('身份同步失败')) throw e;
    }
    return { email };
  }

  // 邮箱密码登录（自托管或 Supabase 两条路径），供 submit 与自动登录复用
  async function performLogin(email, pw) {
    if (sb) {
      const r = await sb.auth.signInWithPassword({ email, password: pw });
      if (r.error) throw new Error(r.error.message || '登录失败');
      const sess = r.data && r.data.session;
      if (!sess) throw new Error('未获取到会话');
      const boot = await bootstrap(sess.access_token, email);
      return { token: sess.access_token, email: boot.email, isSuper: boot.isSuper };
    }
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || d.error || '登录失败');
    return { token: d.userToken, email: d.email, isSuper: !!d.isSuper };
  }

  async function submit() {
    const email = document.getElementById('loginEmail').value.trim();
    const pw = document.getElementById('loginPw').value;
    const realName = (document.getElementById('loginRealName').value || '').trim();
    const rememberEl = document.getElementById('loginRemember');
    const remember = !!(rememberEl && rememberEl.checked);
    const msg = msgEl();
    if (!email || !pw) { msg.textContent = '请填写邮箱和密码'; return; }
    if (loginMode === 'register' && pw.length < 8) { msg.textContent = '密码至少 8 位'; return; }
    if (loginMode === 'register' && !realName) { msg.textContent = '请填写真实姓名'; return; }
    const btn = document.getElementById('loginSubmit');
    btn.disabled = true;
    try {
      if (loginMode === 'register') {
        if (sb) {
          const r = await sb.auth.signUp({ email, password: pw });
          if (r.error) { msg.textContent = r.error.message || '失败'; return; }
          const sess = r.data && r.data.session;
          if (!sess) { msg.textContent = '注册成功，请查收验证邮件后再登录'; return; }
          const boot = await bootstrap(sess.access_token, email);
          done(sess.access_token, boot.email, boot.isSuper);
        } else {
          const r = await fetch('/api/auth/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email, password: pw, realName,
              inviteCode: (document.getElementById('loginInvite').value || '').trim()
            })
          });
          const d = await r.json();
          if (!r.ok) { msg.textContent = d.message || d.error || '失败'; return; }
          done(d.userToken, d.email, d.isSuper);
        }
        return;
      }
      // 登录模式
      const res = await performLogin(email, pw);
      // 记住密码：勾选则保存，否则清除历史保存
      if (remember) saveCreds(email, pw); else clearCreds();
      done(res.token, res.email, res.isSuper);
    } catch (e) { msg.textContent = e.message || '网络错误'; }
    finally { btn.disabled = false; }
  }

  function done(token, email, isSuper, silent) {
    localStorage.setItem('userToken', token);
    localStorage.setItem('userEmail', email || '');
    close();
    if (typeof window.afterLogin === 'function') window.afterLogin(email);
    if (typeof window.applyNavVisibility === 'function') window.applyNavVisibility({ loggedIn: true, isSuper: !!isSuper, email: email });
    if (!silent) {
      const t = document.getElementById('toast');
      if (t) { t.textContent = '登录成功'; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); }
    }
  }

  // 侧栏导航显隐：nav-auth 仅登录可见；nav-super 仅超管可见。
  // 未登录时两项都隐藏，只保留“创建分享”这个简单界面。
  window.applyNavVisibility = function (state) {
    const loggedIn = !!(state && state.loggedIn);
    const isSuper = !!(state && state.isSuper);
    document.querySelectorAll('.nav-auth').forEach(e => { e.style.display = loggedIn ? '' : 'none'; });
    document.querySelectorAll('.nav-super').forEach(e => { e.style.display = (loggedIn && isSuper) ? '' : 'none'; });
  };

  // 自动登录：记住密码且本地无有效会话时，静默用保存的凭据重新登录，实现“不必每次登录”
  let autoLoginStarted = false;
  async function tryAutoLogin() {
    if (autoLoginStarted) return;
    autoLoginStarted = true;
    if (localStorage.getItem('userToken')) return; // 已有会话，无需自动登录
    const saved = loadSaved();
    if (!saved || !saved.email || !saved.password) return;
    try {
      const res = await performLogin(saved.email, saved.password);
      done(res.token, res.email, res.isSuper, true); // 静默恢复，不弹 toast
    } catch (e) {
      clearCreds(); // 凭据失效（如改密），清除避免反复尝试
    }
  }
  window.tryAutoLogin = tryAutoLogin;

  // 密码显示/隐藏切换
  function bindPwToggle() {
    const inp = document.getElementById('loginPw');
    const btn = document.getElementById('loginPwToggle');
    if (!inp || !btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁️';
      btn.title = show ? '隐藏密码' : '显示密码';
    });
  }

  window.openLoginModal = open;
  window.closeLoginModal = close;

  if (modal) {
    document.getElementById('loginSubmit').addEventListener('click', submit);
    const tL = document.getElementById('loginTabLogin'), tR = document.getElementById('loginTabReg');
    if (tL) tL.addEventListener('click', () => { loginMode = 'login'; setMode(); });
    if (tR) tR.addEventListener('click', () => { loginMode = 'register'; setMode(); });
    const lc = document.getElementById('loginClose'); if (lc) lc.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    bindPwToggle();
    // 输入框内按回车直接提交
    ['loginEmail', 'loginPw'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }); });
  }
  if (!window.ENABLE_WECHAT_LOGIN) { const w = document.getElementById('loginWxSection'); if (w) w.style.display = 'none'; }

  // 页面加载时若已勾选“记住密码”且无有效会话，自动登录
  tryAutoLogin();
})();
