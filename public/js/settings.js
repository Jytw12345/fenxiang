'use strict';
// 设置独立页（紧凑版）：账号信息 / 修改密码 / 默认分享参数 / 会话与缓存
(function () {
  const DEFAULT_PREFS = {
    expire: '7', watermark: '', copy: true, print: true, download: true,
    accessCode: '', authMode: 'open', maxViewers: 0, maxViews: 0, duration: 0,
    screenshot: false, previewPages: 0
  };
  const $ = (s) => document.querySelector(s);
  const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };
  const num = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };

  const token = localStorage.getItem('userToken');
  // 未登录时隐藏需要登录的侧栏入口
  if (!token) {
    document.querySelectorAll('.nav .nav-auth, .nav .nav-super').forEach(el => el.style.display = 'none');
    $('#setNeedLogin').style.display = 'block';
    $('#setContent').style.display = 'none';
    $('.set-foot').style.display = 'none';
    if (typeof window.openLoginModal === 'function') setTimeout(() => window.openLoginModal(), 200);
    return;
  }

  function bindToggle(btnId, inpId) {
    const inp = document.getElementById(inpId), btn = document.getElementById(btnId);
    if (!inp || !btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁️';
    });
  }
  bindToggle('setOldToggle', 'setOldPw');
  bindToggle('setNewToggle', 'setNewPw');

  async function load() {
    try {
      const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(token), { cache: 'no-store' });
      if (!r.ok) throw new Error('not ok');
      const d = await r.json();
      $('#setEmail').value = d.email || '';
      $('#setRole').value = d.isSuper ? '超级管理员' : (d.role === 'admin' ? '店长' : '成员');
      $('#setRealName').value = d.realName || '';
      const orgSec = $('#setOrgSec');
      if (orgSec) { $('#setOrg').value = d.orgName || '—'; orgSec.style.display = d.orgName ? 'block' : 'none'; }
      const p = Object.assign({}, DEFAULT_PREFS, d.prefs || {});
      $('#setExpire').value = String(p.expire);
      $('#setAuthMode').value = p.authMode || 'open';
      $('#setCode').value = p.accessCode || '';
      $('#setWatermark').value = p.watermark || '';
      $('#setMaxViewers').value = num(p.maxViewers);
      $('#setMaxViews').value = num(p.maxViews);
      $('#setDuration').value = num(p.duration);
      $('#setPreviewPages').value = num(p.previewPages);
      $('#setCopy').checked = !!p.copy;
      $('#setPrint').checked = !!p.print;
      $('#setDownload').checked = !!p.download;
      $('#setScreenshot').checked = !!p.screenshot;
      $('#setOldPw').value = ''; $('#setNewPw').value = ''; $('#setNewPw2').value = '';
      // 刷新右上角用户信息
      if (typeof window.afterLogin === 'function') window.afterLogin(d.realName || d.email);
    } catch (e) {
      $('#setMsg').textContent = '读取资料失败，请刷新重试';
    }
  }

  async function save() {
    const msg = $('#setMsg');
    const realName = $('#setRealName').value.trim();
    if (!realName) { msg.textContent = '真实姓名不能为空'; return; }

    const oldPw = $('#setOldPw').value, newPw = $('#setNewPw').value, newPw2 = $('#setNewPw2').value;
    if ((oldPw || newPw || newPw2) && (!oldPw || !newPw || !newPw2)) {
      msg.textContent = '修改密码需填原密码、新密码、确认新密码三项'; return;
    }
    if (newPw && newPw !== newPw2) { msg.textContent = '两次输入的新密码不一致'; return; }

    const prefs = {
      expire: $('#setExpire').value,
      authMode: $('#setAuthMode').value,
      accessCode: $('#setCode').value.trim(),
      watermark: $('#setWatermark').value.trim(),
      maxViewers: num($('#setMaxViewers').value),
      maxViews: num($('#setMaxViews').value),
      duration: num($('#setDuration').value),
      previewPages: num($('#setPreviewPages').value),
      copy: $('#setCopy').checked, print: $('#setPrint').checked,
      download: $('#setDownload').checked, screenshot: $('#setScreenshot').checked
    };
    const btn = $('#setSave'); btn.disabled = true;
    try {
      const pr = await fetch('/api/auth/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userToken: token, realName, prefs })
      });
      const pd = await pr.json().catch(() => ({}));
      if (!pr.ok) { msg.textContent = pd.message || pd.error || '保存失败'; btn.disabled = false; return; }
      if (newPw) {
        const cp = await fetch('/api/auth/change-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userToken: token, oldPassword: oldPw, newPassword: newPw })
        });
        const cd = await cp.json().catch(() => ({}));
        if (!cp.ok) { msg.textContent = cd.message || cd.error || '修改密码失败'; btn.disabled = false; return; }
      }
      try { localStorage.setItem('sharePrefs', JSON.stringify(prefs)); } catch (e) {}
      if (typeof window.applySharePrefs === 'function') window.applySharePrefs();
      msg.style.color = '#16a34a';
      msg.textContent = '已保存' + (newPw ? '（密码已修改，其它设备已退出）' : '');
      setTimeout(() => { msg.style.color = '#e5484d'; msg.textContent = ''; }, 2200);
      load();
    } catch (e) {
      msg.textContent = '网络错误，请重试';
    } finally { btn.disabled = false; }
  }

  $('#setSave').onclick = save;

  // 清除本地缓存：清掉分享参数与其它本地缓存（保留登录态）
  const cc = $('#setClearCache');
  if (cc) cc.onclick = () => {
    try {
      localStorage.removeItem('sharePrefs');
      ['sb-token', 'supabase.auth.token'].forEach(k => localStorage.removeItem(k));
      sessionStorage.clear();
    } catch (e) {}
    toast('已清除本地缓存');
    load();
  };

  $('#setLogout').onclick = () => {
    localStorage.removeItem('userToken');
    localStorage.removeItem('savedLogin');
    localStorage.removeItem('sharePrefs');
    location.href = '/';
  };

  load();
})();
