'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

let token = localStorage.getItem('userToken');
let isOwnerToken = false;
const ownerFromUrl = new URLSearchParams(location.search).get('token');
if (!token && ownerFromUrl) { token = ownerFromUrl; localStorage.setItem('ownerToken', ownerFromUrl); isOwnerToken = true; }
if (!token) { token = localStorage.getItem('ownerToken'); if (token) isOwnerToken = true; }

const userArea = document.getElementById('userArea');
function logout() { localStorage.removeItem('userToken'); localStorage.removeItem('userEmail'); location.href = '/'; }
function showLogin() {
  userArea.innerHTML = `<a href="#" id="loginLink">登录 / 注册</a>`;
  document.getElementById('loginLink').onclick = (e) => { e.preventDefault(); if (window.openLoginModal) window.openLoginModal(); };
}
function showVisitor() {
  userArea.innerHTML = `<span>访客管理模式</span> · <a href="#" id="loginLink2">登录归集到我的分享</a>`;
  document.getElementById('loginLink2').onclick = (e) => { e.preventDefault(); if (window.openLoginModal) window.openLoginModal(); };
}
function showUser(email) {
  const safe = String(email || '已登录').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  userArea.innerHTML = `👤 ${safe} · <a href="#" id="logoutLink">退出</a>`;
  document.getElementById('logoutLink').onclick = (e) => { e.preventDefault(); logout(); };
}
window.afterLogin = showUser; // 供 login-modal.js 登录成功后刷新右上角
async function initUserArea() {
  const userToken = localStorage.getItem('userToken');
  // 先显示默认入口，避免异步校验期间右上角空白
  if (isOwnerToken) showVisitor(); else showLogin();
  if (!userToken) return;
  try {
    const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(userToken), { cache: 'no-store' });
    if (!r.ok) throw new Error('session_invalid');
    const d = await r.json();
    if (d.email) localStorage.setItem('userEmail', d.email);
    showUser(d.email);
  } catch (e) {
    // 令牌无效：清除并回到登录入口（不跳转、不重载，避免刷新死循环）
    localStorage.removeItem('userToken');
    localStorage.removeItem('userEmail');
    if (isOwnerToken) showVisitor(); else showLogin();
  }
}
initUserArea();

if (!token) {
  document.getElementById('list').innerHTML = '<div class="empty">请先<a href="/auth.html">登录</a>，或打开创建分享时的「管理后台」链接。</div>';
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function load() {
  if (!token) return;
  const r = await fetch('/api/admin/' + token);
  const d = await r.json();
  const list = $('#list');
  if (!d.shares || !d.shares.length) { $('#empty').style.display = 'block'; list.innerHTML = ''; return; }
  $('#empty').style.display = 'none';
  list.innerHTML = d.shares.map(s => {
    const link = location.origin + s.link;
    const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '永久';
    const r = s.restrictions;
    const tags = [
      s.status === 'active' ? '<span class="tag on">已上架</span>' : '<span class="tag off">已销毁</span>',
      s.authMode === 'approve' ? '<span class="tag on">需授权</span>' : '',
      s.accessCode ? '<span class="tag on">有访问码</span>' : '',
      r.copy ? '<span class="tag off">禁复制</span>' : '', r.print ? '<span class="tag off">禁打印</span>' : '',
      r.download ? '<span class="tag off">禁下载</span>' : '', r.screenshot ? '<span class="tag off">防截图</span>' : ''
    ].join('');
    return `<div class="share-item">
      <div class="hd"><div class="nm">${esc(s.name)}</div><div class="badge">${s.kind}</div></div>
      <div class="meta">打开 ${s.opens} 次 · 访客 ${s.viewers} 人 · 有效期至 ${exp} · 上限 ${s.maxViewers || '∞'}人 / ${s.maxViews || '∞'}次</div>
      <div>${tags}</div>
      <div class="acts" style="margin-top:10px">
        <a class="btn ghost sm" href="${link}" target="_blank">预览</a>
        <button class="btn ghost sm" onclick="copyLink('${link}')">复制链接</button>
        <button class="btn ghost sm" onclick="showLogs('${s.shareId}')">访问记录</button>
        <button class="btn ghost sm" onclick="editShare('${s.shareId}')">改权限</button>
        ${s.authMode === 'approve' ? `<button class="btn ghost sm" onclick="showApprovals('${s.shareId}')">授权</button>` : ''}
        ${s.status === 'active'
          ? `<button class="btn danger sm" onclick="destroy('${s.shareId}')">远程销毁</button>`
          : `<button class="btn sm" onclick="restore('${s.shareId}')">恢复</button>`}
      </div>
    </div>`;
  }).join('');
}
window.copyLink = (l) => { navigator.clipboard.writeText(l); toast('已复制'); };
window.showLogs = async (id) => {
  const r = await fetch(`/api/admin/${token}/share/${id}/viewers`); const d = await r.json();
  const v = d.viewers || [];
  if (!v.length) { $('#logsBody').innerHTML = '<p class="sub">暂无访问记录</p>'; $('#logsModal').classList.add('show'); return; }
  $('#logsBody').innerHTML = `<table class="vt">
    <tr><th>查看者</th><th>IP</th><th>位置</th><th>设备/系统</th><th>浏览器</th><th>首次访问</th><th>最近访问</th><th>次数</th></tr>
    ${v.map(x => {
      const loc = [x.country, x.region, x.city].filter(Boolean).join('·') || '—';
      const dev = [x.device, x.os].filter(Boolean).join('/');
      const first = new Date(x.firstAt).toLocaleString();
      const last = new Date(x.lastAt).toLocaleString();
      return `<tr>
        <td>${esc(x.viewerToken.slice(0,8))}<br><span class="sub">进度 ${esc(x.lastProgress || '—')}</span></td>
        <td>${esc(x.ip || '—')}</td>
        <td>${esc(loc)}</td>
        <td>${esc(dev)}</td>
        <td>${esc(x.browser)}</td>
        <td>${first}</td>
        <td>${last}</td>
        <td>${x.opens} 次</td>
      </tr>`;
    }).join('')}
  </table>
  <p class="sub" style="margin-top:10px">注：IP 与地理位置由访客网络决定，可能受代理 / 移动网络影响；内网访问标记为「内网/局域网」。</p>`;
  $('#logsModal').classList.add('show');
};
window.destroy = async (id) => { await fetch(`/api/admin/${token}/share/${id}/destroy`, { method: 'POST' }); toast('已远程销毁'); load(); };
window.restore = async (id) => { await fetch(`/api/admin/${token}/share/${id}/restore`, { method: 'POST' }); toast('已恢复'); load(); };

let editId = null;
window.editShare = async (id) => {
  editId = id;
  const r = await fetch(`/api/admin/${token}`); const d = await r.json();
  const s = d.shares.find(x => x.shareId === id);
  $('#editBody').innerHTML = `
    <div class="row">
      <div class="field"><label>有效期(天,0=永久)</label><input id="eExp" type="number" value="${s.expiresAt ? Math.ceil((s.expiresAt - Date.now())/86400000) : 0}"></div>
      <div class="field"><label>最大人数</label><input id="eMV" type="number" value="${s.maxViewers}"></div>
    </div>
    <div class="row">
      <div class="field"><label>最大次数</label><input id="eMO" type="number" value="${s.maxViews}"></div>
      <div class="field"><label>单次时长(分)</label><input id="eDur" type="number" value="${Math.round(s.durationSec/60)}"></div>
    </div>
    <div class="field"><label>访问码</label><input id="eCode" value="${s.accessCode || ''}"></div>
    <div class="field"><label>验证方式</label><select id="eAuth"><option value="open" ${s.authMode==='open'?'selected':''}>公开</option><option value="approve" ${s.authMode==='approve'?'selected':''}>申请授权</option></select></div>
    <div class="field"><label>水印</label><input id="eWm" value="${esc(s.watermark)}"></div>
    <div class="checks">
      <label><input type="checkbox" id="eCopy" ${s.restrictions.copy?'checked':''}>禁复制</label>
      <label><input type="checkbox" id="ePrint" ${s.restrictions.print?'checked':''}>禁打印</label>
      <label><input type="checkbox" id="eDl" ${s.restrictions.download?'checked':''}>禁下载</label>
      <label><input type="checkbox" id="eSc" ${s.restrictions.screenshot?'checked':''}>防截图</label>
    </div>`;
  $('#editModal').classList.add('show');
};
$('#saveEdit').onclick = async () => {
  const expVal = parseInt($('#eExp').value, 10) || 0;
  const body = {
    maxViewers: parseInt($('#eMV').value, 10) || 0, maxViews: parseInt($('#eMO').value, 10) || 0,
    durationSec: (parseInt($('#eDur').value, 10) || 0) * 60, accessCode: $('#eCode').value.trim() || null,
    authMode: $('#eAuth').value, watermark: $('#eWm').value.trim(),
    disableCopy: $('#eCopy').checked, disablePrint: $('#ePrint').checked,
    disableDownload: $('#eDl').checked, disableScreenshot: $('#eSc').checked,
    expiresAt: expVal ? Date.now() + expVal * 86400000 : null
  };
  await fetch(`/api/admin/${token}/share/${editId}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('#editModal').classList.remove('show'); toast('权限已更新'); load();
};

window.showApprovals = async (id) => {
  const r = await fetch(`/api/admin/${token}/share/${id}/approvals`); const d = await r.json();
  $('#apprBody').innerHTML = d.approvals.length
    ? d.approvals.map(a => `<div class="share-item" style="margin-bottom:8px"><div class="meta">访客 ${esc(a.viewer_token.slice(0,8))} · ${new Date(a.requested_at).toLocaleString()}</div>
        <div class="acts"><button class="btn sm" onclick="decide('${id}','${a.viewer_token}','approve')">通过</button>
        <button class="btn danger sm" onclick="decide('${id}','${a.viewer_token}','reject')">拒绝</button></div></div>`).join('')
    : '<p class="sub">暂无待授权申请</p>';
  $('#apprModal').classList.add('show');
};
window.decide = async (id, vt, decision) => {
  await fetch(`/api/admin/${token}/share/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewerToken: vt, decision }) });
  toast(decision === 'approve' ? '已授权' : '已拒绝'); showApprovals(id);
};

load();

// ---------- 店长（组织）后台 ----------
const orgToken = localStorage.getItem('userToken');
async function initOrg() {
  if (!orgToken) return;
  let me;
  try { const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(orgToken)); me = await r.json(); }
  catch (e) { return; }
  if (!me || me.role !== 'admin') return;

  const tabs = $('#tabs');
  const list = $('#list');
  const orgPanel = $('#orgPanel');
  const superPanel = $('#superPanel');
  const sub = { org: $('#orgShares'), members: $('#orgMembers'), invite: $('#orgInvite') };
  // 超级管理员额外 tab
  if (me.isSuper) { $('#tabStats').style.display = ''; $('#tabUsers').style.display = ''; $('#tabAudit').style.display = ''; }
  tabs.style.display = 'flex';
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const t = btn.dataset.tab;
      const superTabs = ['stats', 'users', 'audit'];
      if (superTabs.includes(t)) {
        list.style.display = 'none'; orgPanel.style.display = 'none'; superPanel.style.display = 'block';
        $('#superStats').style.display = t === 'stats' ? 'block' : 'none';
        $('#superUsers').style.display = t === 'users' ? 'block' : 'none';
        $('#superAudit').style.display = t === 'audit' ? 'block' : 'none';
        if (t === 'stats') loadStats();
        if (t === 'users') loadUsers();
        if (t === 'audit') loadAudit();
        return;
      }
      if (t === 'mine') { list.style.display = 'block'; orgPanel.style.display = 'none'; superPanel.style.display = 'none'; load(); }
      else {
        list.style.display = 'none'; orgPanel.style.display = 'block'; superPanel.style.display = 'none';
        sub.org.style.display = t === 'org' ? 'block' : 'none';
        sub.members.style.display = t === 'members' ? 'block' : 'none';
        sub.invite.style.display = t === 'invite' ? 'block' : 'none';
        if (t === 'org') loadOrgShares();
        if (t === 'members') loadMembers();
      }
    });
  });

  $('#genInvite').addEventListener('click', async () => {
    const r = await fetch('/api/org/invite?userToken=' + encodeURIComponent(orgToken), { method: 'POST' });
    const d = await r.json();
    if (d.code) { const c = $('#inviteCode'); c.textContent = '邀请码：' + d.code; c.style.display = 'inline-block'; toast('已生成：' + d.code); }
  });
}

function renderShares(container, shares, withOwner) {
  if (!shares || !shares.length) { container.innerHTML = '<div class="empty">暂无分享</div>'; return; }
  container.innerHTML = shares.map(s => {
    const link = location.origin + s.link;
    const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '永久';
    const r = s.restrictions || {};
    const tags = [
      s.status === 'active' ? '<span class="tag on">已上架</span>' : '<span class="tag off">已销毁</span>',
      withOwner ? `<span class="tag">${esc(s.ownerEmail || '匿名')}</span>` : '',
      s.authMode === 'approve' ? '<span class="tag on">需授权</span>' : '',
      s.accessCode ? '<span class="tag on">有访问码</span>' : '',
      r.copy ? '<span class="tag off">禁复制</span>' : '', r.print ? '<span class="tag off">禁打印</span>' : '',
      r.download ? '<span class="tag off">禁下载</span>' : '', r.screenshot ? '<span class="tag off">防截图</span>' : ''
    ].join('');
    return `<div class="share-item">
      <div class="hd"><div class="nm">${esc(s.name)}</div><div class="badge">${s.kind}</div></div>
      <div class="meta">打开 ${s.opens} 次 · 访客 ${s.viewers} 人 · 有效期至 ${exp}</div>
      <div>${tags}</div>
      <div class="acts" style="margin-top:10px">
        <a class="btn ghost sm" href="${link}" target="_blank">预览</a>
        <button class="btn ghost sm" onclick="copyLink('${link}')">复制链接</button>
        <button class="btn ghost sm" onclick="showLogs('${s.shareId}')">访问记录</button>
        <button class="btn ghost sm" onclick="editShare('${s.shareId}')">改权限</button>
        ${s.authMode === 'approve' ? `<button class="btn ghost sm" onclick="showApprovals('${s.shareId}')">授权</button>` : ''}
        ${s.status === 'active'
          ? `<button class="btn danger sm" onclick="destroy('${s.shareId}')">远程销毁</button>`
          : `<button class="btn sm" onclick="restore('${s.shareId}')">恢复</button>`}
      </div>
    </div>`;
  }).join('');
}

async function loadOrgShares() {
  const r = await fetch('/api/org/shares?userToken=' + encodeURIComponent(orgToken));
  const d = await r.json();
  renderShares($('#orgShares'), d.shares, true);
}
async function loadMembers() {
  const r = await fetch('/api/org/members?userToken=' + encodeURIComponent(orgToken));
  const d = await r.json();
  const box = $('#orgMembers');
  box.innerHTML = !d.members || !d.members.length ? '<div class="empty">暂无成员</div>'
    : `<table><tr><th>邮箱</th><th>角色</th><th>加入时间</th></tr>${d.members.map(m => `<tr><td>${esc(m.email)}</td><td>${m.role === 'admin' ? '店长' : '员工'}</td><td>${new Date(m.createdAt).toLocaleString()}</td></tr>`).join('')}</table>`;
}

async function loadStats() {
  const r = await fetch('/api/super/stats?userToken=' + encodeURIComponent(orgToken));
  const d = await r.json();
  if (d.error) { $('#superStats').innerHTML = '<div class="empty">无权访问</div>'; return; }
  const byStatus = d.byStatus || {};
  const topUsers = (d.topUsers || []).map(u => `<tr><td>${esc(u.email)}</td><td>${fmtBytes(u.bytes)}</td><td>${u.shareCount}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">暂无</td></tr>';
  const topShares = (d.topShares || []).map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.ownerEmail)}</td><td>${fmtBytes(s.size)}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">暂无</td></tr>';
  $('#superStats').innerHTML = `
    <div class="card">
      <h2>存储总览</h2>
      <div class="stat-row">
        <div class="stat"><div class="num">${fmtBytes(d.totalBytes)}</div><div class="lbl">已用总空间</div></div>
        <div class="stat"><div class="num">${d.totalFiles}</div><div class="lbl">文件总数</div></div>
        <div class="stat"><div class="num">${byStatus.active || 0}</div><div class="lbl">生效中分享</div></div>
        <div class="stat"><div class="num">${byStatus.destroyed || 0}</div><div class="lbl">已销毁分享</div></div>
      </div>
      ${d.orphanCount ? `<div class="warn">检测到 ${d.orphanCount} 个孤儿文件（已销毁/未分享），可释放 <b>${fmtBytes(d.orphanBytes)}</b>。
        <button class="btn sm" id="cleanupBtn" style="margin-left:8px">一键清理</button></div>` : '<p class="sub">暂无可回收的孤儿文件。</p>'}
    </div>
    <div class="card">
      <h2>占用 Top 用户</h2>
      <table><tr><th>邮箱</th><th>占用</th><th>分享数</th></tr>${topUsers}</table>
    </div>
    <div class="card">
      <h2>占用 Top 分享</h2>
      <table><tr><th>文件名</th><th>分享人</th><th>大小</th></tr>${topShares}</table>
    </div>`;
  const cb = $('#cleanupBtn');
  if (cb) cb.onclick = async () => {
    if (!confirm('确定清理孤儿文件？此操作不可恢复。')) return;
    const rr = await fetch('/api/super/cleanup?userToken=' + encodeURIComponent(orgToken), { method: 'POST' });
    const dd = await rr.json();
    toast(dd.ok ? `已清理 ${dd.deleted} 个文件，释放 ${fmtBytes(dd.freed)}` : '清理失败');
    loadStats();
  };
}
async function loadUsers() {
  const r = await fetch('/api/super/users?userToken=' + encodeURIComponent(orgToken));
  const d = await r.json();
  if (d.error) { $('#superUsers').innerHTML = '<div class="empty">无权访问</div>'; return; }
  const rows = (d.users || []).map(u => {
    const tags = [u.isSuper ? '<span class="tag on">超级管理员</span>' : '', u.role === 'admin' ? '<span class="tag on">店长</span>' : '', u.disabled ? '<span class="tag off">已禁用</span>' : ''].join(' ');
    const acts = [
      u.disabled ? `<button class="btn ghost sm" onclick="userAct('${u.id}','enable')">启用</button>` : `<button class="btn ghost sm" onclick="userAct('${u.id}','disable')">禁用</button>`,
      `<button class="btn ghost sm" onclick="userAct('${u.id}','role',${u.role === 'admin' ? '\'member\'' : '\'admin\''})">${u.role === 'admin' ? '降为员工' : '设为店长'}</button>`,
      `<button class="btn ghost sm" onclick="userAct('${u.id}','super',${u.isSuper ? 'false' : 'true'})">${u.isSuper ? '取消超管' : '设为超管'}</button>`,
      `<button class="btn danger sm" onclick="userAct('${u.id}','delete')">删除</button>`
    ].join(' ');
    return `<tr><td>${esc(u.email)} ${tags}</td><td>${fmtBytes(u.bytes)}</td><td>${u.shareCount}</td><td>${new Date(u.createdAt).toLocaleString()}</td><td>${acts}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="sub">暂无用户</td></tr>';
  $('#superUsers').innerHTML = `<div class="card"><h2>注册用户（${d.users.length}）</h2>
    <table><tr><th>邮箱</th><th>占用</th><th>分享数</th><th>注册时间</th><th>操作</th></tr>${rows}</table>
    <p class="sub" style="margin-top:8px">禁用后该账号无法登录；删除会同时清除其所有分享与文件。</p></div>`;
}
window.userAct = async (id, action, val) => {
  let body = null, confirmMsg = null;
  if (action === 'delete') confirmMsg = '确定删除该用户及其所有分享/文件？不可恢复！';
  else if (action === 'disable') confirmMsg = '确定禁用该账号？';
  if (confirmMsg && !confirm(confirmMsg)) return;
  if (action === 'role') body = JSON.stringify({ role: val });
  if (action === 'super') body = JSON.stringify({ super: val });
  const r = await fetch(`/api/super/user/${id}/${action}?userToken=` + encodeURIComponent(orgToken), {
    method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body
  });
  const d = await r.json();
  toast(d.ok ? '操作成功' : (d.message || '操作失败'));
  loadUsers();
};
async function loadAudit() {
  const r = await fetch('/api/super/audit?userToken=' + encodeURIComponent(orgToken));
  const d = await r.json();
  if (d.error) { $('#superAudit').innerHTML = '<div class="empty">无权访问</div>'; return; }
  const rows = (d.logs || []).map(l => `<tr><td>${new Date(l.createdAt).toLocaleString()}</td><td>${esc(l.action)}</td><td>${esc(l.target)}</td><td class="sub">${esc(l.detail)}</td></tr>`).join('') || '<tr><td colspan="4" class="sub">暂无记录</td></tr>';
  $('#superAudit').innerHTML = `<div class="card"><h2>操作日志</h2>
    <table><tr><th>时间</th><th>动作</th><th>对象</th><th>详情</th></tr>${rows}</table></div>`;
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

initOrg();
