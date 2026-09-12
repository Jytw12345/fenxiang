'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

let token = localStorage.getItem('userToken');
const ownerFromUrl = new URLSearchParams(location.search).get('token');
if (!token && ownerFromUrl) { token = ownerFromUrl; localStorage.setItem('ownerToken', ownerFromUrl); }
if (!token) token = localStorage.getItem('ownerToken');

const userArea = document.getElementById('userArea');
function renderUserArea() {
  if (localStorage.getItem('userToken')) {
    const email = localStorage.getItem('userEmail') || '已登录';
    userArea.innerHTML = `👤 ${email} · <a href="#" id="logoutLink">退出</a>`;
    document.getElementById('logoutLink').onclick = (e) => {
      e.preventDefault();
      localStorage.removeItem('userToken'); localStorage.removeItem('userEmail');
      location.href = '/';
    };
  } else if (token) {
    userArea.innerHTML = `<span>访客管理模式</span> · <a href="/auth.html">登录归集到我的分享</a>`;
  } else {
    userArea.innerHTML = `<a href="/auth.html">登录 / 注册</a>`;
  }
}
renderUserArea();

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
  const r = await fetch(`/api/admin/${token}/share/${id}/logs`); const d = await r.json();
  $('#logsBody').innerHTML = d.logs.length
    ? `<table><tr><th>时间</th><th>访客</th><th>IP</th><th>事件</th><th>进度</th></tr>${d.logs.map(l => `<tr><td>${new Date(l.created_at).toLocaleString()}</td><td>${esc(l.viewer_token.slice(0,8))}</td><td>${esc(l.ip)}</td><td>${esc(l.event)}</td><td>${esc(l.progress)}</td></tr>`).join('')}</table>`
    : '<p class="sub">暂无访问记录</p>';
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
  const sub = { org: $('#orgShares'), members: $('#orgMembers'), invite: $('#orgInvite') };
  tabs.style.display = 'flex';
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const t = btn.dataset.tab;
      if (t === 'mine') { list.style.display = 'block'; orgPanel.style.display = 'none'; load(); }
      else {
        list.style.display = 'none'; orgPanel.style.display = 'block';
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

initOrg();
