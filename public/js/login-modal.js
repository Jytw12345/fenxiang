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
    const sub = document.getElementById('loginSub'); if (sub) sub.textContent = isLogin ? '登录以管理你的分享' : '注册后即可上传文件并生成受限链接';
    document.getElementById('loginSubmit').textContent = isLogin ? '登录' : '注册';
    const tL = document.getElementById('loginTabLogin'), tR = document.getElementById('loginTabReg');
    if (tL) tL.classList.toggle('active', isLogin);
    if (tR) tR.classList.toggle('active', !isLogin);
    document.getElementById('loginInviteField').style.display = isLogin ? 'none' : 'block';
    document.getElementById('loginRealNameField').style.display = isLogin ? 'none' : 'block';
    // 注册模式不展示“记住密码”（注册后本就直接登录）
    const rr = document.querySelector('.remember-row'); if (rr) rr.style.display = isLogin ? 'flex' : 'none';
    const foot = document.getElementById('loginFoot');
    if (foot) foot.textContent = isLogin ? '登录即表示同意内部使用规范' : '点击「注册」即表示同意内部使用规范';
    updatePwMeter();
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
  // 常见英文报错 → 中文（Supabase Auth 返回英文 message；本地接口偶有英文 error code）
  const ERR_ZH = [
    [/invalid login credentials/i, '邮箱或密码不正确'],
    [/user already registered|already been registered|already exists|email_exists/i, '该邮箱已注册，请直接登录'],
    [/email not confirmed/i, '邮箱尚未验证，请先查收验证邮件'],
    [/password should be at least/i, '密码长度不足，请查看密码要求'],
    [/signups? not allowed|signup_disabled|reg_disabled/i, '当前未开放注册，请联系管理员'],
    [/rate limit|too many requests|every \d+ seconds/i, '操作太频繁，请稍后再试'],
    [/invalid format|invalid email/i, '邮箱格式不正确'],
    [/failed to fetch|networkerror|network error|load failed/i, '网络异常，请检查网络后重试'],
    [/timeout|timed out/i, '请求超时，请重试'],
    [/new password should be different/i, '新密码不能与旧密码相同'],
    [/anonymous sign-?ins? are disabled/i, '当前不支持匿名登录'],
    [/real_name_required/i, '请填写真实姓名'],
    [/invite_required|invalid_invite/i, '邀请码无效或必填'],
    [/weak_password/i, '密码强度不足'],
    [/captcha|human verification/i, '人机验证未通过，请重试'],
  ];
  function zhErr(m) {
    if (!m) return m;
    for (const [re, zh] of ERR_ZH) if (re.test(m)) return zh;
    return m;
  }
  async function performLogin(email, pw) {
    if (sb) {
      const r = await sb.auth.signInWithPassword({ email, password: pw });
      if (r.error) throw new Error(zhErr(r.error.message) || '登录失败');
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
    if (!r.ok) throw new Error(zhErr(d.message || d.error) || '登录失败');
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
          if (r.error) { msg.textContent = zhErr(r.error.message) || '注册失败，请稍后重试'; return; }
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
          if (!r.ok) { msg.textContent = zhErr(d.message || d.error) || '注册失败，请稍后重试'; return; }
          done(d.userToken, d.email, d.isSuper);
        }
        return;
      }
      // 登录模式
      const res = await performLogin(email, pw);
      // 记住密码：勾选则保存，否则清除历史保存
      if (remember) saveCreds(email, pw); else clearCreds();
      done(res.token, res.email, res.isSuper);
    } catch (e) { msg.textContent = zhErr(e.message) || '网络错误'; }
    finally { btn.disabled = false; }
  }

  function done(token, email, isSuper, silent) {
    localStorage.setItem('userToken', token);
    localStorage.setItem('userEmail', email || '');
    close();
    // 回写 admin.js 的闭包 token，让刷新前的界面（右上角/导航）先切到登录态
    if (typeof window.__setAdminToken === 'function') window.__setAdminToken(token);
    if (typeof window.afterLogin === 'function') window.afterLogin(email);
    if (typeof window.applyNavVisibility === 'function') window.applyNavVisibility({ loggedIn: true, isSuper: !!isSuper, email: email });
    if (!silent) {
      const t = document.getElementById('toast');
      if (t) { t.textContent = '登录成功'; t.classList.add('show'); }
    }
    // 登录成功后整页刷新一次：后台各面板（我的分享/全店分享/文件管理/数据概览…）都是按
    // 「页面解析时的登录态」决定是否拉数据的，晚于页面加载的登录不会自动重拉，用户会看到空列表。
    // 统一刷新一次最可靠；刷新后已有 token，不会再触发登录，无循环风险。
    // 静默登录（记住密码自动恢复）不留看 toast，立即刷；手动登录留 650ms 让用户看到「登录成功」。
    setTimeout(() => location.reload(), silent ? 50 : 650);
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

  // 密码显示/隐藏切换：用内联 SVG 双图标 + .on 类，不依赖 emoji 字体
  function bindPwToggle() {
    const inp = document.getElementById('loginPw');
    const btn = document.getElementById('loginPwToggle');
    if (!inp || !btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
      btn.title = show ? '隐藏密码' : '显示密码';
    });
  }

  // 密码强度：长度 + 大小写/数字/符号的字符种类，映射成 3 档（仅注册模式显示）
  function pwScore(pw) {
    if (!pw) return 0;
    let s = 0;
    if (pw.length >= 8) s++;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    if (s <= 1) return 1;
    if (s <= 3) return 2;
    return 3;
  }
  const PW_LABEL = { 1: '弱', 2: '中', 3: '强' };
  function updatePwMeter() {
    const meter = document.getElementById('pwMeter');
    if (!meter) return;
    const pw = document.getElementById('loginPw').value || '';
    const lv = pwScore(pw);
    // 只在注册模式且已输入时出现，登录模式下不打扰
    meter.hidden = loginMode !== 'register' || !pw;
    if (!lv) return;
    meter.setAttribute('data-lv', String(lv));
    const t = document.getElementById('pwMeterText');
    if (t) t.textContent = PW_LABEL[lv];
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
    const pwEl = document.getElementById('loginPw');
    if (pwEl) pwEl.addEventListener('input', updatePwMeter);
    // 输入框内按回车直接提交
    ['loginEmail', 'loginPw'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }); });
  }
  if (!window.ENABLE_WECHAT_LOGIN) { const w = document.getElementById('loginWxSection'); if (w) w.style.display = 'none'; }

  // 页面加载时若已勾选“记住密码”且无有效会话，自动登录
  tryAutoLogin();
})();
