'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

// 是否启用 Supabase 身份体系（由 env.js 配置；未配置或被强制关闭则回退自研账号）
const sb = window.sb || null;

// 若未启用微信登录，隐藏整段微信入口
if (!window.ENABLE_WECHAT_LOGIN) {
  const wxSection = document.getElementById('wxSection');
  if (wxSection) wxSection.style.display = 'none';
}

let mode = 'login'; // login | register

function goApp(token, email) {
  localStorage.setItem('userToken', token);
  localStorage.setItem('userEmail', email || '');
  location.href = '/admin.html';
}

// 首登引导：调用后端 /api/auth/bootstrap 确保本地用户行 + 归属组织，再进后台
async function bootstrapAndGo(token, email) {
  if (!sb) { goApp(token, email); return; }
  const invite = (new URLSearchParams(location.search).get('invite') || '').trim();
  try {
    const r = await fetch('/api/auth/bootstrap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userToken: token, inviteCode: invite })
    });
    if (r.ok) { const d = await r.json(); goApp(token, d.email || email); return; }
  } catch (e) { /* 网络异常也放行，后续接口会要求登录 */ }
  goApp(token, email);
}

// 已登录则直接进入 / 接管微信回调
if (sb) {
  sb.auth.getSession().then(async ({ data }) => {
    if (data.session) {
      localStorage.setItem('userToken', data.session.access_token);
      await bootstrapAndGo(data.session.access_token, data.session.user && data.session.user.email);
    } else {
      localStorage.removeItem('userToken'); // 清理旧的自研令牌，避免误判
    }
  });
} else if (localStorage.getItem('userToken')) {
  $('#formCard').style.display = 'none';
  $('#alreadyIn').style.display = 'block';
}

$('#toggleMode').addEventListener('click', (e) => {
  e.preventDefault();
  mode = mode === 'login' ? 'register' : 'login';
  $('#formTitle').textContent = mode === 'login' ? '登录' : '注册';
  $('#submitBtn').textContent = mode === 'login' ? '登录' : '注册';
  $('#toggleMode').textContent = mode === 'login' ? '没有账号？去注册' : '已有账号？去登录';
  $('#inviteField').style.display = mode === 'register' ? 'block' : 'none';
  $('#authMsg').textContent = '';
});

$('#submitBtn').addEventListener('click', async () => {
  const email = $('#email').value.trim();
  const pw = $('#pw').value;
  if (!email || !pw) return toast('请填写邮箱和密码');
  if (mode === 'register' && pw.length < 8) { $('#authMsg').textContent = '密码至少 8 位'; return; }
  $('#submitBtn').disabled = true;
  try {
    if (sb) {
      let r = mode === 'register'
        ? await sb.auth.signUp({ email, password: pw })
        : await sb.auth.signInWithPassword({ email, password: pw });
      if (r.error) { $('#authMsg').textContent = r.error.message || '失败'; return; }
      const sess = r.data && r.data.session;
      if (!sess) { $('#authMsg').textContent = '注册成功，请查收验证邮件后再登录'; return; }
      await bootstrapAndGo(sess.access_token, email);
      return;
    }
    // 自研账号体系（未配置 Supabase 时）
    const r = await fetch('/api/auth/' + mode, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw, inviteCode: mode === 'register' ? ($('#invite').value || '').trim() : '' })
    });
    const d = await r.json();
    if (!r.ok) { $('#authMsg').textContent = d.message || d.error || '失败'; return; }
    goApp(d.userToken, d.email);
  } catch (e) {
    $('#authMsg').textContent = '网络错误';
  } finally {
    $('#submitBtn').disabled = false;
  }
});

// ---------- 微信扫码登录 ----------
let wxState = null, wxTimer = null;
$('#wxBtn').addEventListener('click', async () => {
  // Supabase 模式：直接走 Supabase 的微信 OAuth（需在 Supabase 后台开启 WeChat 提供商）
  if (sb) {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'wechat', options: { redirectTo: location.href } });
    if (error) toast('微信登录启动失败：' + error.message);
    return;
  }
  // 自研模式：调用后端 /api/wechat/start（真实/模拟双模式）
  $('#wxBtn').disabled = true;
  try {
    const r = await fetch('/api/wechat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'login' }) });
    const d = await r.json();
    if (!r.ok) { toast('微信登录启动失败'); $('#wxBtn').disabled = false; return; }
    wxState = d.state;
    $('#wxBox').style.display = 'block';
    if (d.mode === 'real') {
      $('#wxQr').style.display = 'none';
      let f = $('#wxFrame');
      if (!f) { f = document.createElement('iframe'); f.id = 'wxFrame'; f.style.cssText = 'width:240px;height:300px;border:0;margin:0 auto;display:block'; $('#wxBox').prepend(f); }
      f.src = d.qrUrl;
      $('#wxSim').style.display = 'none';
    } else {
      $('#wxQr').src = d.qr; $('#wxQr').style.display = 'block';
      $('#wxSim').style.display = 'inline-block';
    }
    wxTimer = setInterval(checkWx, 1500);
  } catch (e) { toast('微信登录启动失败'); $('#wxBtn').disabled = false; }
});

async function checkWx() {
  if (!wxState) return;
  const r = await fetch('/api/wechat/check?state=' + wxState);
  const d = await r.json();
  if (d.ok && d.userToken) {
    clearInterval(wxTimer);
    goApp(d.userToken, d.email);
  }
}

$('#wxSim').addEventListener('click', async () => {
  if (!wxState) return toast('请先点「微信扫码登录」生成二维码');
  const r = await fetch('/api/wechat/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: wxState }) });
  const d = await r.json();
  if (!r.ok) return toast('确认失败');
});
