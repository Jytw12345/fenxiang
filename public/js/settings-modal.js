'use strict';
// 设置弹窗（首页与管理后台共用）：账号设置（改密码/改真实姓名/显示邮箱角色/退出）
// + 默认分享参数（有效期/水印/复制/打印/下载），保存后新建分享自动带入。
// 弹窗 DOM 由本脚本注入到 body，两个页面只需引入本脚本即可。
(function () {
  const DEFAULT_PREFS = { expire: '7', watermark: '', copy: true, print: true, download: true };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 注入弹窗结构
  function ensureModal() {
    if (document.getElementById('settingsModal')) return;
    const div = document.createElement('div');
    div.className = 'modal';
    div.id = 'settingsModal';
    div.innerHTML = `
      <div class="box" style="max-width:480px">
        <button class="modal-close" id="setClose" aria-label="关闭">×</button>
        <h2>设置</h2>
        <div id="setMsg" class="form-msg"></div>

        <div class="set-sec">
          <h3><span class="dot"></span>账号信息</h3>
          <div class="set-grid">
            <div class="field"><label>邮箱（不可修改）</label><input id="setEmail" readonly style="background:var(--bg,#f5f6f8);color:var(--muted)" /></div>
            <div class="field"><label>角色</label><input id="setRole" readonly style="background:var(--bg,#f5f6f8);color:var(--muted)" /></div>
          </div>
          <div class="field" style="margin-top:12px"><label>真实姓名</label><input id="setRealName" placeholder="请输入真实姓名" /></div>
        </div>

        <div class="set-sec">
          <h3><span class="dot"></span>修改密码（留空则不修改）</h3>
          <div class="field"><label>原密码</label><div class="pw-wrap"><input id="setOldPw" type="password" placeholder="原密码" /><button type="button" class="pw-toggle" id="setOldToggle" title="显示/隐藏">👁️</button></div></div>
          <div class="set-grid" style="margin-top:12px">
            <div class="field"><label>新密码</label><div class="pw-wrap"><input id="setNewPw" type="password" placeholder="至少 8 位，含字母和数字" /><button type="button" class="pw-toggle" id="setNewToggle" title="显示/隐藏">👁️</button></div></div>
            <div class="field"><label>确认新密码</label><input id="setNewPw2" type="password" placeholder="再次输入新密码" /></div>
          </div>
        </div>

        <div class="set-sec">
          <h3><span class="dot"></span>默认分享参数（新建分享自动带入）</h3>
          <div class="set-grid">
            <div class="field"><label>默认有效期</label>
              <select id="setExpire">
                <option value="1">1 天</option>
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="0">永久有效</option>
              </select>
            </div>
            <div class="field"><label>默认水印</label><input id="setWatermark" placeholder="水印文字（如：内部资料 严禁外传）" /></div>
          </div>
          <div class="chips" style="margin-top:12px">
            <label class="switch"><input type="checkbox" id="setCopy" checked /> <span>默认禁止复制</span></label>
            <label class="switch"><input type="checkbox" id="setPrint" checked /> <span>默认禁止打印</span></label>
            <label class="switch"><input type="checkbox" id="setDownload" checked /> <span>默认禁止下载</span></label>
          </div>
        </div>

        <div class="set-sec" id="setOrgSec" style="display:none">
          <h3><span class="dot"></span>组织信息</h3>
          <div class="field"><label>所属组织</label><input id="setOrg" readonly style="background:var(--bg,#f5f6f8);color:var(--muted)" /></div>
        </div>

        <div style="display:flex;gap:10px;margin-top:6px">
          <button class="btn" id="setSave" style="flex:1">保存设置</button>
          <button class="btn danger" id="setLogout" style="flex:0 0 auto">退出登录</button>
        </div>
      </div>`;
    document.body.appendChild(div);

    const modal = div;
    $('#setClose').onclick = () => modal.classList.remove('show');
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('show'); });
    bindToggle('setOldToggle', 'setOldPw');
    bindToggle('setNewToggle', 'setNewPw');
    $('#setSave').onclick = save;
    $('#setLogout').onclick = () => { if (typeof logout === 'function') logout(); };
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

  function open() {
    const token = localStorage.getItem('userToken');
    if (!token) { if (window.openLoginModal) window.openLoginModal(); return; }
    ensureModal();
    const modal = document.getElementById('settingsModal');
    const msg = $('#setMsg'); msg.textContent = '加载中…';
    fetch('/api/auth/me?userToken=' + encodeURIComponent(token), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => {
        $('#setEmail').value = d.email || '';
        const role = d.isSuper ? '超级管理员' : (d.role === 'admin' ? '店长' : '成员');
        $('#setRole').value = role;
        $('#setRealName').value = d.realName || '';
        const orgSec = document.getElementById('setOrgSec');
        if (orgSec) { $('#setOrg').value = d.orgName || '—'; orgSec.style.display = d.orgName ? 'block' : 'none'; }
        const p = Object.assign({}, DEFAULT_PREFS, d.prefs || {});
        $('#setExpire').value = String(p.expire);
        $('#setWatermark').value = p.watermark || '';
        $('#setCopy').checked = !!p.copy;
        $('#setPrint').checked = !!p.print;
        $('#setDownload').checked = !!p.download;
        $('#setOldPw').value = ''; $('#setNewPw').value = ''; $('#setNewPw2').value = '';
        msg.textContent = '';
        modal.classList.add('show');
      })
      .catch(() => { msg.textContent = '读取资料失败，请重试'; });
  }

  async function save() {
    const token = localStorage.getItem('userToken');
    if (!token) return;
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
      watermark: $('#setWatermark').value.trim(),
      copy: $('#setCopy').checked, print: $('#setPrint').checked, download: $('#setDownload').checked
    };
    const btn = $('#setSave'); btn.disabled = true;
    try {
      // 1) 资料 + 默认参数
      const pr = await fetch('/api/auth/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userToken: token, realName, prefs })
      });
      const pd = await pr.json().catch(() => ({}));
      if (!pr.ok) { msg.textContent = pd.message || pd.error || '保存失败'; btn.disabled = false; return; }
      // 2) 改密码（如有）
      if (newPw) {
        const cp = await fetch('/api/auth/change-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userToken: token, oldPassword: oldPw, newPassword: newPw })
        });
        const cd = await cp.json().catch(() => ({}));
        if (!cp.ok) { msg.textContent = cd.message || cd.error || '修改密码失败'; btn.disabled = false; return; }
      }
      // 3) 写本地默认参数 + 应用到分享表单
      try { localStorage.setItem('sharePrefs', JSON.stringify(prefs)); } catch (e) {}
      if (typeof window.applySharePrefs === 'function') window.applySharePrefs();
      // 4) 刷新右上角真实姓名（若 afterLogin 接受字符串）
      if (typeof window.afterLogin === 'function') window.afterLogin(realName);
      msg.style.color = '#16a34a';
      msg.textContent = '已保存' + (newPw ? '（密码已修改，其它设备已退出）' : '');
      setTimeout(() => { msg.style.color = '#e5484d'; document.getElementById('settingsModal').classList.remove('show'); }, 900);
    } catch (e) {
      msg.textContent = '网络错误，请重试';
    } finally { btn.disabled = false; }
  }

  // 绑定侧栏「设置」入口（两个页面都是 <a href="#">…设置…</a>）
  function bindNav() {
    document.querySelectorAll('.nav a').forEach(a => {
      if (a.textContent.indexOf('设置') >= 0) {
        a.href = 'javascript:void(0)';
        a.onclick = (e) => { e.preventDefault(); open(); };
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindNav);
  else bindNav();
  window.openSettingsModal = open;
})();
