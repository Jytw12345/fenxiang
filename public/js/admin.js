'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

let token = localStorage.getItem('userToken');
// 安全：后台界面必须登录后才能进入。不再使用 ownerToken（匿名创建者无法进入管理后台）。
const userArea = document.getElementById('userArea');
function logout() { localStorage.removeItem('userToken'); localStorage.removeItem('userEmail'); localStorage.removeItem('savedLogin'); location.href = '/'; }
function showLogin() {
  userArea.innerHTML = `<a href="#" id="loginLink">登录 / 注册</a>`;
  document.getElementById('loginLink').onclick = (e) => { e.preventDefault(); if (window.openLoginModal) window.openLoginModal(); };
}
function showUser(email) {
  const safe = String(email || '已登录').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  userArea.innerHTML = `👤 ${safe} · <a href="#" id="logoutLink">退出</a>`;
  document.getElementById('logoutLink').onclick = (e) => { e.preventDefault(); logout(); };
}
window.afterLogin = showUser; // 供 login-modal.js 登录成功后刷新右上角
async function initUserArea() {
  const userToken = localStorage.getItem('userToken');
  // 未登录默认隐藏受保护导航项
  if (typeof window.applyNavVisibility === 'function') window.applyNavVisibility({ loggedIn: false });
  showLogin();
  if (!userToken) return;
  try {
    const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(userToken), { cache: 'no-store' });
    if (!r.ok) throw new Error('session_invalid');
    const d = await r.json();
    if (d.email) localStorage.setItem('userEmail', d.email);
    showUser(d.email);
    if (typeof window.applyNavVisibility === 'function') window.applyNavVisibility({ loggedIn: true, isSuper: !!d.isSuper, email: d.email });
  } catch (e) {
    // 令牌无效：清除并回到登录入口（不跳转、不重载，避免刷新死循环）
    localStorage.removeItem('userToken');
    localStorage.removeItem('userEmail');
    showLogin();
    if (typeof window.applyNavVisibility === 'function') window.applyNavVisibility({ loggedIn: false });
  }
}
initUserArea();

if (!token) {
  document.getElementById('list').innerHTML = '<div class="empty">请先<a href="/">登录</a>后再进入管理后台。</div>';
  document.querySelectorAll('.nav .nav-auth, .nav .nav-super').forEach(el => el.style.display = 'none');
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function load() {
  if (!token) return;
  const r = await fetch('/api/admin/' + token);
  const d = await r.json();
  const list = $('#list');
  if (!d.shares || !d.shares.length) { $('#empty').style.display = 'block'; list.innerHTML = ''; return; }
  $('#empty').style.display = 'none';
  list.innerHTML = `<div class="card-grid">` + d.shares.map(s => shareCardHtml(s, true)).join('') + `</div>`;
}
// 紧凑分享卡片（网格布局）。own=true 表示是“我的分享”，展示替换文件入口。
function shareCardHtml(s, own) {
  const link = location.origin + s.link;
  const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '永久';
  const r = s.restrictions || {};
  const tags = [
    s.status === 'active' ? '<span class="tag on">已上架</span>' : '<span class="tag off">已销毁</span>',
    s.authMode === 'approve' ? '<span class="tag on">需授权</span>' : '',
    s.accessCode ? '<span class="tag on">有访问码</span>' : '',
    r.copy ? '<span class="tag off">禁复制</span>' : '', r.print ? '<span class="tag off">禁打印</span>' : '',
    r.download ? '<span class="tag off">禁下载</span>' : '', r.screenshot ? '<span class="tag off">防截图</span>' : ''
  ].join('');
  const acts = [
    `<a class="btn ghost sm" href="${link}" target="_blank">预览</a>`,
    `<button class="btn ghost sm" onclick="copyLink('${link}')">复制链接</button>`,
    `<button class="btn ghost sm" onclick="showLogs('${s.shareId}')">访问记录</button>`,
    `<button class="btn ghost sm" onclick="editShare('${s.shareId}')">改权限</button>`,
    s.authMode === 'approve' ? `<button class="btn ghost sm" onclick="showApprovals('${s.shareId}')">授权</button>` : '',
    own && s.fileId ? `<button class="btn ghost sm" onclick="replaceFile('${s.fileId}')">替换文件</button>` : '',
    s.status === 'active'
      ? `<button class="btn danger sm" onclick="destroy('${s.shareId}')">远程销毁</button>`
      : `<button class="btn sm" onclick="restore('${s.shareId}')">恢复</button>`
  ].join('');
  return `<div class="share-card">
    <div class="hd"><div class="nm" title="${esc(s.name)}">${esc(s.name)}</div><div class="badge">${s.kind}</div></div>
    <div class="meta">打开 ${s.opens} 次 · 访客 ${s.viewers} 人 · 有效期至 ${exp}${s.maxViewers ? ' · 上限 ' + s.maxViewers + '人' : ''}</div>
    <div class="tags">${tags}</div>
    <div class="acts">${acts}</div>
  </div>`;
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
  if (!me) return;

  const tabs = $('#tabs');
  const list = $('#list');
  const orgPanel = $('#orgPanel');
  const superPanel = $('#superPanel');
  const sub = { org: $('#orgShares'), members: $('#orgMembers'), invite: $('#orgInvite') };
  // 所有登录用户都能看到「我的分享」
  tabs.style.display = 'flex';
  // 店长才显示组织管理 tab；普通成员隐藏
  if (me.role === 'admin') {
    document.querySelectorAll('.tab[data-tab="org"], .tab[data-tab="members"], .tab[data-tab="invite"]').forEach(el => el.style.display = '');
  } else {
    document.querySelectorAll('.tab[data-tab="org"], .tab[data-tab="members"], .tab[data-tab="invite"]').forEach(el => el.style.display = 'none');
  }
  // 超级管理员额外 tab
  if (me.isSuper) { $('#tabAllShares').style.display = ''; $('#tabStats').style.display = ''; $('#tabDashboard').style.display = ''; $('#tabUsers').style.display = ''; $('#tabAudit').style.display = ''; }
  // 所有登录用户可见「文件管理」tab（tabFiles 已默认显示）

  const superTabs = ['allshares', 'stats', 'dashboard', 'users', 'audit'];
  function highlightSideNav(t) {
    document.querySelectorAll('#sideNav a').forEach(a => a.classList.remove('active'));
    let key = 'mine';
    if (t === 'files') key = 'files';
    else if (superTabs.includes(t) || ['org', 'members', 'invite'].includes(t)) key = 'super';
    const a = document.querySelector(`#sideNav a[data-key="${key}"]`);
    if (a) a.classList.add('active');
  }
  function switchTab(t) {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.tab[data-tab="${t}"]`);
    if (btn) btn.classList.add('active');
    // 隐藏所有面板
    list.style.display = 'none'; orgPanel.style.display = 'none'; superPanel.style.display = 'none';
    $('#filesPanel').style.display = 'none'; $('#dashboardPanel').style.display = 'none';
    if (superTabs.includes(t)) {
      superPanel.style.display = 'block';
      $('#superAllShares').style.display = t === 'allshares' ? 'block' : 'none';
      $('#superStats').style.display = t === 'stats' ? 'block' : 'none';
      $('#superUsers').style.display = t === 'users' ? 'block' : 'none';
      $('#superAudit').style.display = t === 'audit' ? 'block' : 'none';
      if (t === 'allshares') loadAllShares();
      if (t === 'stats') loadStats();
      if (t === 'users') loadUsers();
      if (t === 'audit') loadAudit();
    } else if (t === 'mine') { list.style.display = 'block'; load(); }
    else if (t === 'files') { $('#filesPanel').style.display = 'block'; loadFiles(); }
    else if (t === 'dashboard') { $('#dashboardPanel').style.display = 'block'; loadDashboard(); }
    else {
      orgPanel.style.display = 'block';
      sub.org.style.display = t === 'org' ? 'block' : 'none';
      sub.members.style.display = t === 'members' ? 'block' : 'none';
      sub.invite.style.display = t === 'invite' ? 'block' : 'none';
      if (t === 'org') loadOrgShares();
      if (t === 'members') loadMembers();
    }
    highlightSideNav(t);
  }
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tab;
      if (location.hash !== '#' + t) {
        history.replaceState(null, '', '#' + t);
      }
      switchTab(t);
    });
  });
  // 根据 URL hash 初始化 tab；默认 mine
  const initTab = location.hash.replace('#', '') || 'mine';
  switchTab(initTab);
  window.addEventListener('hashchange', () => switchTab(location.hash.replace('#', '') || 'mine'));

  $('#genInvite').addEventListener('click', async () => {
    const r = await fetch('/api/org/invite?userToken=' + encodeURIComponent(orgToken), { method: 'POST' });
    const d = await r.json();
    if (d.code) { const c = $('#inviteCode'); c.textContent = '邀请码：' + d.code; c.style.display = 'inline-block'; toast('已生成：' + d.code); }
  });
}

function renderShares(container, shares, withOwner, own) {
  if (!shares || !shares.length) { container.innerHTML = '<div class="empty">暂无分享</div>'; return; }
  container.innerHTML = (withOwner ? `<div class="card-grid with-owner">` : `<div class="card-grid">`) +
    shares.map(s => {
      const card = shareCardHtml(s, own);
      return withOwner ? card.replace('<div class="badge">', `<div class="badge owner">${esc(s.ownerEmail || '匿名')}</div><div class="badge">`) : card;
    }).join('') + `</div>`;
}

async function loadOrgShares() {
  const r = await fetch('/api/org/shares?userToken=' + encodeURIComponent(orgToken));
  const d = await r.json();
  renderShares($('#orgShares'), d.shares, true, false);
}
async function loadAllShares() {
  const r = await fetch('/api/super/shares?userToken=' + encodeURIComponent(orgToken));
  const d = await r.json();
  if (d.error) { $('#superAllShares').innerHTML = '<div class="empty">无权访问</div>'; return; }
  renderShares($('#superAllShares'), d.shares, true, true);
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
// 操作日志中文渲染辅助
const AUDIT_ACTIONS = {
  create_share: '创建分享', destroy_share: '删除分享', restore_share: '恢复分享',
  edit_share: '编辑分享', approve_share: '审批访问', create_invite: '生成邀请码',
  cleanup: '清理存储',   disable_user: '禁用用户', enable_user: '启用用户',
  set_role: '调整角色', set_super: '调整超管', delete_user: '删除用户', create_user: '注册账号',
  login: '登录', logout: '退出'
};
function auditActionName(action) { return AUDIT_ACTIONS[action] || action; }
function parseAuditDetail(detail) {
  const map = {};
  if (!detail) return map;
  for (const part of String(detail).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    map[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return map;
}
function formatAuditTarget(action, target, detail) {
  const d = parseAuditDetail(detail);
  if (target === 'org') return '组织';
  if (target === 'storage') return '存储空间';
  if (action && action.endsWith('_user')) return d.email ? `用户 ${esc(d.email)}` : '用户';
  // 其余按分享处理：从详情取文件名，避免显示 12 位 shareId
  if (d.name) return `分享《${esc(d.name)}》`;
  if (/^[0-9a-f]{12}$/i.test(String(target))) return '分享';
  return esc(target || '—');
}
function formatAuditDetail(action, detail) {
  const d = parseAuditDetail(detail);
  const parts = [];
  if (d.name && !(action && action.endsWith('_user'))) parts.push(`文件：${esc(d.name)}`);
  if (d.code) parts.push(`邀请码：${esc(d.code)}`);
  if (d.viewer) {
    const decisionMap = { approved: '已通过', rejected: '已拒绝' };
    const decision = decisionMap[d.decision] || (d.decision || '—');
    parts.push(`申请人：${esc(d.viewer)} · 结果：${decision}`);
  }
  if (d.email) parts.push(`邮箱：${esc(d.email)}`);
  if (d.role) parts.push(`角色：${d.role === 'admin' ? '店长' : '员工'}`);
  if ('super' in d) parts.push(`超级管理员：${d.super === 'true' || d.super === '1' ? '是' : '否'}`);
  if (d.shares) parts.push(`分享数：${esc(d.shares)}`);
  if (d.files || d.bytes) {
    const size = d.bytes ? fmtBytes(Number(d.bytes)) : '';
    parts.push(`清理文件：${Number(d.files) || 0}${size ? ' · 释放：' + size : ''}`);
  }
  return parts.length ? parts.join(' · ') : esc(detail || '—');
}

function auditQueryString() {
  const p = new URLSearchParams();
  const action = $('#afAction').value; if (action) p.set('action', action);
  const tt = $('#afTarget').value; if (tt) p.set('targetType', tt);
  const actor = $('#afActor').value.trim(); if (actor) p.set('actor', actor);
  const q = $('#afQ').value.trim(); if (q) p.set('q', q);
  const from = $('#afFrom').value; if (from) p.set('from', String(new Date(from).getTime()));
  const to = $('#afTo').value; if (to) p.set('to', String(new Date(to).getTime() + 86399999));
  return p.toString();
}
async function loadAudit() {
  const box = $('#superAudit');
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>操作日志</h2>
    <div class="audit-bar">
      <div class="ab"><label>动作</label><select id="afAction">
        <option value="">全部</option>
        <option value="create_share">创建分享</option>
        <option value="destroy_share">删除分享</option>
        <option value="restore_share">恢复分享</option>
        <option value="edit_share">编辑分享</option>
        <option value="approve_share">审批访问</option>
        <option value="create_invite">生成邀请码</option>
        <option value="cleanup">清理存储</option>
        <option value="disable_user">禁用用户</option>
        <option value="enable_user">启用用户</option>
        <option value="set_role">调整角色</option>
        <option value="set_super">调整超管</option>
        <option value="delete_user">删除用户</option>
        <option value="create_user">注册账号</option>
      </select></div>
      <div class="ab"><label>对象类型</label><select id="afTarget">
        <option value="">全部</option>
        <option value="share">分享</option>
        <option value="user">用户</option>
        <option value="org">组织</option>
        <option value="storage">存储空间</option>
      </select></div>
      <div class="ab grow"><label>操作人（邮箱/姓名）</label><input id="afActor" placeholder="如 309953160@qq.com" /></div>
      <div class="ab grow"><label>关键词</label><input id="afQ" placeholder="文件名 / 邀请码 / 详情" /></div>
      <div class="ab"><label>起始时间</label><input id="afFrom" type="date" /></div>
      <div class="ab"><label>结束时间</label><input id="afTo" type="date" /></div>
      <div class="ab-acts"><button class="btn sm" id="afSearch">查询</button><button class="btn ghost sm" id="afReset">重置</button></div>
    </div>
    <div id="auditTableWrap"></div>
  </div>`;
  ['afAction', 'afTarget', 'afActor', 'afQ', 'afFrom', 'afTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('change', fetchAudit); el.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchAudit(); }); }
  });
  document.getElementById('afSearch').onclick = fetchAudit;
  document.getElementById('afReset').onclick = () => {
    ['afAction', 'afTarget', 'afActor', 'afQ', 'afFrom', 'afTo'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    fetchAudit();
  };
  await fetchAudit();
}
async function fetchAudit() {
  const wrap = document.getElementById('auditTableWrap');
  if (!wrap) return;
  const qs = auditQueryString();
  wrap.innerHTML = '<p class="sub">加载中…</p>';
  try {
    const r = await fetch('/api/super/audit?userToken=' + encodeURIComponent(orgToken) + (qs ? '&' + qs : ''));
    const d = await r.json();
    if (d.error) { wrap.innerHTML = '<div class="empty">无权访问</div>'; return; }
    const rows = (d.logs || []).map(l => {
      const actor = l.actorEmail ? esc(l.actorRealName || l.actorEmail) : '系统';
      return `<tr>
        <td>${new Date(l.createdAt).toLocaleString()}</td>
        <td>${esc(auditActionName(l.action))}</td>
        <td>${formatAuditTarget(l.action, l.target, l.detail)}</td>
        <td>${formatAuditDetail(l.action, l.detail)}</td>
        <td class="sub">${actor}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="sub">暂无记录</td></tr>';
    wrap.innerHTML = `<table><tr><th>时间</th><th>动作</th><th>对象</th><th>详情</th><th>操作人</th></tr>${rows}</table>
      <p class="sub" style="margin-top:8px">共 ${d.logs ? d.logs.length : 0} 条${qs ? '（已按条件筛选）' : ''}</p>`;
  } catch (e) { wrap.innerHTML = '<div class="empty">加载失败</div>'; }
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

initOrg();

// ---------- 文件管理 ----------
async function loadFiles() {
  const box = $('#filesPanel');
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>文件管理</h2>
    <div class="audit-bar">
      <div class="ab grow"><label>按人员筛选（仅超管）</label><input id="fileOwner" placeholder="输入邮箱关键词，如 309953160" ${!isSuperNow() ? 'disabled' : ''} /></div>
      <div class="ab-acts"><button class="btn sm" id="fileRefresh">刷新</button></div>
    </div>
    <div id="fileGrid" class="card-grid"></div>
    <p class="sub" style="margin-top:10px">说明：替换文件会覆盖原文件内容，但<b>分享链接保持不变</b>，客户始终看到最新文件；仅当文件未被任何分享引用时方可删除。</p>
  </div>`;
  const ownerInput = document.getElementById('fileOwner');
  if (ownerInput) ownerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') renderFileGrid(); });
  document.getElementById('fileRefresh').onclick = renderFileGrid;
  await renderFileGrid();
}
async function renderFileGrid() {
  const grid = document.getElementById('fileGrid');
  if (!grid) return;
  grid.innerHTML = '<p class="sub">加载中…</p>';
  let url = '/api/files?userToken=' + encodeURIComponent(orgToken);
  if (isSuperNow()) {
    url += '&scope=all';
    const owner = document.getElementById('fileOwner');
    if (owner && owner.value.trim()) url += '&owner=' + encodeURIComponent(owner.value.trim());
  }
  try {
    const r = await fetch(url); const d = await r.json();
    if (d.error) { grid.innerHTML = '<div class="empty">无权访问</div>'; return; }
    const files = d.files || [];
    if (!files.length) { grid.innerHTML = '<div class="empty">暂无文件</div>'; return; }
    grid.innerHTML = files.map(f => {
      const ic = f.kind === 'pdf' ? '📕' : f.kind === 'image' ? '🖼️' : f.kind === 'docx' ? '📘' : '📄';
      const ownerLine = f.ownerEmail ? `<div class="meta">归属：${esc(f.ownerEmail)}</div>` : '';
      const shareLine = f.shareCount > 0 ? `<div class="meta">被 ${f.shareCount} 个分享引用${f.shareName ? ' · 《' + esc(f.shareName) + '》' : ''}</div>` : '<div class="meta off">未分享（孤儿文件）</div>';
      return `<div class="file-card">
        <div class="hd"><span class="fic">${ic}</span><div class="nm" title="${esc(f.name)}">${esc(f.name)}</div></div>
        <div class="meta">${fmtBytes(f.size)} · ${new Date(f.createdAt).toLocaleDateString()}</div>
        ${shareLine}${ownerLine}
        <div class="acts">
          <button class="btn ghost sm" onclick="replaceFile('${f.fileId}')">替换文件</button>
          <button class="btn danger sm" onclick="deleteFile('${f.fileId}')">删除</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) { grid.innerHTML = '<div class="empty">加载失败</div>'; }
}
function isSuperNow() {
  // 通过超管专属 tab 是否可见判断当前会话是否为超管
  const t = document.getElementById('tabUsers');
  return !!(t && t.style.display !== 'none');
}
window.replaceFile = (fileId) => {
  const inp = document.getElementById('replaceFileInput');
  inp.value = '';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    if (!confirm('确定用「' + file.name + '」替换该文件？分享链接保持不变，客户将看到新文件。')) { inp.onchange = null; return; }
    const btn = toast('正在替换…');
    try {
      const buf = await file.arrayBuffer();
      const up = await fetch('/api/files/' + fileId + '/replace?userToken=' + encodeURIComponent(orgToken) + '&name=' + encodeURIComponent(file.name) + '&mime=' + encodeURIComponent(file.type || 'application/octet-stream'), {
        method: 'POST', body: buf
      });
      const d = await up.json().catch(() => ({}));
      if (!up.ok) throw new Error(d.message || d.error || ('替换失败 HTTP ' + up.status));
      toast('✅ 已替换，分享链接不变');
      renderFileGrid();
    } catch (e) { toast('失败：' + e.message); }
    inp.onchange = null;
  };
  inp.click();
};
window.deleteFile = async (fileId) => {
  if (!confirm('确定删除该文件？')) return;
  try {
    const r = await fetch('/api/files/' + fileId + '?userToken=' + encodeURIComponent(orgToken), { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (d.error === 'file_in_use' && d.shares) {
        alert('该文件仍被以下分享引用，请先处理这些分享：\n' + d.shares.map(s => s.name).join('\n'));
      } else throw new Error(d.message || d.error || ('删除失败 HTTP ' + r.status));
    } else toast('✅ 已删除');
    renderFileGrid();
  } catch (e) { toast('失败：' + e.message); }
};

// ---------- 数据概览 ----------
function loadDashboard() {
  const box = $('#dashboardPanel');
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>数据概览</h2><div id="dashBody"><p class="sub">加载中…</p></div></div>`;
  fetch('/api/dashboard?userToken=' + encodeURIComponent(orgToken))
    .then(r => r.json()).then(d => {
      if (d.error) { $('#dashBody').innerHTML = '<div class="empty">无权访问</div>'; return; }
      const t = d.totals || {};
      const scopeTxt = d.scope === 'global' ? '（全局）' : '（仅本人）';
      const top = (d.topShares || []).map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.ownerEmail || '匿名')}</td><td>${s.opens}</td><td>${s.viewers}</td></tr>`).join('') || '<tr><td colspan="4" class="sub">暂无</td></tr>';
      const rv = (d.recentViewers || []).map(v => {
        const last = v.lastAt ? new Date(v.lastAt).toLocaleString() : '—';
        const loc = v.loc || '—';
        return `<tr><td>${esc((v.viewerToken || '').slice(0, 8))}</td><td>${esc(v.shareName || '—')}</td><td>${esc(v.ownerEmail || '—')}</td><td>${v.events} 次</td><td>${esc(loc)}</td><td>${esc(v.device || '—')}</td><td>${last}</td></tr>`;
      }).join('') || '<tr><td colspan="7" class="sub">暂无访客</td></tr>';
      $('#dashBody').innerHTML = `
        <div class="stat-row">
          <div class="stat"><div class="num">${t.fileCount}</div><div class="lbl">文件总数</div></div>
          <div class="stat"><div class="num">${t.shareCount}</div><div class="lbl">分享总数</div></div>
          <div class="stat"><div class="num">${t.totalOpens}</div><div class="lbl">累计访问</div></div>
          <div class="stat"><div class="num">${t.totalViewers}</div><div class="lbl">独立访客</div></div>
        </div>
        <div class="card sub-card"><h3>热门分享 Top ${scopeTxt}</h3>
          <table><tr><th>文件名</th><th>分享人</th><th>打开次数</th><th>访客数</th></tr>${top}</table>
        </div>
        <div class="card sub-card"><h3>最近访客 ${scopeTxt}</h3>
          <table><tr><th>访客</th><th>访问文件</th><th>分享人</th><th>次数</th><th>位置</th><th>设备</th><th>最近访问</th></tr>${rv}</table>
        </div>`;
    })
    .catch(() => { $('#dashBody').innerHTML = '<div class="empty">加载失败</div>'; });
}

