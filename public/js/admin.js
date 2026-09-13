'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

// ---- 自定义确认/提示弹窗：替代系统原生 confirm/alert，避免阻塞页面与体验割裂 ----
// openDialog 返回一个 Promise<boolean>（single=true 时 Promise<true>），复用 .modal/.box 样式动态生成。
let _dlgSeq = 0;
function openDialog({ title = '', message = '', okText = '确定', cancelText = '取消', danger = false, single = false } = {}) {
  return new Promise((resolve) => {
    const id = 'dlg_' + (++_dlgSeq);
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = id;
    modal.innerHTML = `<div class="box" style="text-align:left;">
      ${title ? `<div class="dlg-title">${esc(title)}</div>` : ''}
      <div class="dlg-msg">${esc(message)}</div>
      <div class="dlg-acts">
        ${single ? '' : `<button class="btn ghost" id="${id}_cancel">${esc(cancelText)}</button>`}
        <button class="btn ${danger ? 'danger' : ''}" id="${id}_ok">${esc(okText)}</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    let done = false;
    const close = (val) => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey);
      modal.classList.remove('show');
      setTimeout(() => modal.remove(), 200);
      resolve(val);
    };
    function onKey(e) { if (e.key === 'Escape') close(false); }
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', (e) => { if (e.target === modal && !danger) close(false); });
    modal.classList.add('show');
    modal.querySelector('#' + id + '_ok').onclick = () => close(true);
    const cancelBtn = modal.querySelector('#' + id + '_cancel');
    if (cancelBtn) cancelBtn.onclick = () => close(false);
  });
}
const confirmDialog = (message, opts = {}) => openDialog({ message, ...opts });
const alertDialog = (message, opts = {}) => openDialog({ message, single: true, ...opts });

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
  loadAndApplyPrefs();
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

// 标签数据缓存：切换标签不再每次重新拉取，消除“切换=整页刷新”的观感（尤其 Supabase 东京区冷启动 6-8s 时）。
// panelLoaded[t] 为 true 表示已加载过，切换回来只切 display，不回源。
const panelLoaded = {};
let meState = null;       // 当前登录用户信息（role/isSuper/orgName）
let mineShares = [];      // 我的分享本地缓存（乐观更新用）
const selectedShareIds = new Set();  // 我的分享：批量操作选中集（跨重渲染保留）
let selMode = false;                 // 是否处于批量选择模式：默认关闭，卡片不带勾选框
const shareById = new Map();         // shareId -> { s, own }，供右键菜单取当前分享数据

async function load() {
  if (!token) return;
  const r = await fetch('/api/admin/' + token);
  const d = await r.json();
  mineShares = d.shares || [];
  renderMineGrid();
}
// 用本地缓存重渲染「我的分享」网格（无网络请求，乐观更新用）
function renderMineGrid() {
  const list = $('#list');
  // 选中集与当前列表对齐：已被删除/移出的分享自动从选中集剔除，避免"幽灵选中"导致批量操作报无权
  const alive = new Set((mineShares || []).map(s => s.shareId));
  Array.from(selectedShareIds).forEach(id => { if (!alive.has(id)) selectedShareIds.delete(id); });
  if (!mineShares || !mineShares.length) { $('#empty').style.display = 'block'; list.innerHTML = ''; return; }
  $('#empty').style.display = 'none';
  mineShares.forEach(s => shareById.set(s.shareId, { s, own: true }));
  list.innerHTML = shareSelBarHtml() +
    `<div class="card-grid">` + mineShares.map(s => shareCardHtml(s, true, selMode)).join('') + `</div>`;
  bindShareSel();
  syncShareBatchBar();
  bindCtxMenus();
}
// 批量操作条有两种形态：
//  - 常规（selMode=false）：只有右侧一个「批量操作」按钮，默认视图与没有批量功能时几乎一样；
//  - 选择中（selMode=true）：展开 全选 / 已选 N 项 / 动作按钮 / 退出批量，卡片同时出现勾选框。
function shareSelBarHtml() {
  if (!selMode) {
    return `<div class="selbar lite" id="shareSelBar">
      <button class="btn ghost sm" id="btnSelOn">批量操作</button>
    </div>`;
  }
  // 标签刻意保持短：整条在 676px 宽度下仍能一行放下（带"批量"前缀会挤成三排）
  return `<div class="selbar active" id="shareSelBar">
    <label class="selall"><input type="checkbox" id="shareSelAll"><span>全选</span></label>
    <span class="selcnt" id="shareSelCount"></span>
    <div class="selacts" id="shareSelActs" hidden>
      <button class="btn ghost sm" onclick="bulkEditShares()">改权限</button>
      <button class="btn ghost sm" onclick="bulkShareStatus('destroy')">销毁</button>
      <button class="btn ghost sm" onclick="bulkShareStatus('restore')">恢复</button>
      <button class="btn ghost sm" onclick="bulkCopyLinks()">复制链接</button>
      <button class="btn ghost sm" onclick="clearShareSel()">取消选择</button>
      <button class="btn danger sm" onclick="bulkDeleteShares()">删除</button>
    </div>
    <button class="btn ghost sm seloff" id="btnSelOff">退出批量</button>
  </div>`;
}
function syncShareBatchBar() {
  const n = selectedShareIds.size, total = (mineShares || []).length;
  const cnt = document.getElementById('shareSelCount');
  if (cnt) cnt.innerHTML = n ? `已选 <b>${n}</b> 项` : `共 ${total} 个分享`;
  const acts = document.getElementById('shareSelActs');
  if (acts) acts.hidden = n === 0;
  const bar = document.getElementById('shareSelBar');
  if (bar) bar.classList.toggle('active', selMode);
  const all = document.getElementById('shareSelAll');
  if (all) { all.checked = total > 0 && n === total; all.indeterminate = n > 0 && n < total; }
}
// 只在勾选单项时局部刷新批量条，不整栅格重渲染 —— 避免每点一下就抖一次布局
function bindShareSel() {
  const on = document.getElementById('btnSelOn');
  if (on) on.onclick = () => { selMode = true; renderMineGrid(); };
  const off = document.getElementById('btnSelOff');
  if (off) off.onclick = () => { selMode = false; selectedShareIds.clear(); renderMineGrid(); };
  const all = document.getElementById('shareSelAll');
  if (all) all.onchange = () => {
    if (all.checked) mineShares.forEach(s => selectedShareIds.add(s.shareId));
    else selectedShareIds.clear();
    renderMineGrid();
  };
  document.querySelectorAll('#list .share-chk input').forEach(c => {
    c.onchange = () => {
      if (c.checked) selectedShareIds.add(c.dataset.sid); else selectedShareIds.delete(c.dataset.sid);
      syncShareBatchBar();
    };
  });
}
window.clearShareSel = () => { selectedShareIds.clear(); renderMineGrid(); };

// 紧凑分享卡片（网格布局）。own=true 表示是“我的分享”，展示替换文件入口。
// selectable=true 时在卡片左上渲染批量勾选框（仅「我的分享」启用）。
// 操作区采用「主操作 + 更多菜单」两段式：预览/复制链接常驻，次级操作收进「更多」，
// 这样在 280px 宽的卡片里也能保证操作按钮只占一行，且功能一个不少。
function shareCardHtml(s, own, selectable) {
  const link = location.origin + s.link;
  const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '永久';
  const r = s.restrictions || {};
  const extra = s.extra || {};
  const hasPreviewLimit = !!(extra.previewPages && Number(extra.previewPages) > 0);
  const tags = [
    s.status === 'active' ? '<span class="tag on">已上架</span>' : '<span class="tag off">已销毁</span>',
    s.authMode === 'approve' ? '<span class="tag on">需授权</span>' : '',
    s.accessCode ? '<span class="tag on">有访问码</span>' : '',
    hasPreviewLimit ? '<span class="tag on">限前' + extra.previewPages + '页</span>' : '',
    hasPreviewLimit && extra.protectPassword ? '<span class="tag on">有密码</span>' : '',
    r.copy ? '<span class="tag off">禁复制</span>' : '', r.print ? '<span class="tag off">禁打印</span>' : '',
    r.download ? '<span class="tag off">禁下载</span>' : '', r.screenshot ? '<span class="tag off">防截图</span>' : ''
  ].join('');
  const menuId = 'sm_' + s.shareId;
  const checked = selectedShareIds.has(s.shareId);
  return `<div class="share-card${checked ? ' sel' : ''}" data-sid="${s.shareId}" data-own="${own ? 1 : 0}">
    <div class="hd">
      ${selectable ? `<label class="share-chk" title="选择此分享用于批量操作"><input type="checkbox" data-sid="${s.shareId}" ${checked ? 'checked' : ''}></label>` : ''}
      <div class="nm" title="${esc(s.name)}">${esc(s.name)}</div>
      <div class="rt">
        <div class="badge">${s.kind}</div>
        <button class="del" title="删除分享及文件" data-act="deleteShare" data-sid="${s.shareId}">删除</button>
      </div>
    </div>
    <div class="meta">打开 ${s.opens} 次 · 访客 ${s.viewers} 人 · 有效期至 ${exp}${s.maxViewers ? ' · 上限 ' + s.maxViewers + '人' : ''}</div>
    <div class="tags">${tags}</div>
    <div class="acts">
      <a class="btn ghost sm" href="${link}" target="_blank" rel="noopener">预览</a>
      <button class="btn ghost sm" data-act="copy">复制链接</button>
      <div class="row-menu">
        <button class="btn ghost sm menu-btn" onclick="toggleRowMenu(event,'${menuId}')">更多 ▾</button>
        <div class="menu-list" id="${menuId}">${shareMenuHtml(s, own)}</div>
      </div>
    </div>
  </div>`;
}
// 分享的可用动作集中定义一次，供「更多」菜单与右键菜单共用 —— 两处不会再走偏。
// 分隔线用 '-' 表示。
function shareMenuItems(s, own) {
  const items = [
    { act: 'logs', label: '访问记录' },
    { act: 'edit', label: '改权限' }
  ];
  if (s.authMode === 'approve') items.push({ act: 'approve', label: '授权申请' });
  if (own && s.fileId) items.push({ act: 'replace', label: '替换文件' });
  items.push('-');
  if (s.status === 'active') items.push({ act: 'destroy', label: '远程销毁', danger: true });
  else items.push({ act: 'restore', label: '恢复分享' });
  return items;
}
// 用 data-act + 事件委托渲染菜单项：不再往标记里拼内联 onclick，
// 分享名/文件名里带引号也不会把 HTML 打断。
function shareMenuHtml(s, own) {
  return shareMenuItems(s, own).map(it => it === '-'
    ? '<div class="menu-sep"></div>'
    : `<button class="${it.danger ? 'danger' : ''}" data-act="${it.act}" data-sid="${s.shareId}" data-file="${s.fileId || ''}">${it.label}</button>`
  ).join('');
}
window.copyLink = (l) => { navigator.clipboard.writeText(l); toast('已复制'); };

// 格式化阅读时长（秒 → 中文）
function fmtDur(sec) {
  sec = Number(sec) || 0;
  if (sec < 60) return sec + ' 秒';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? `${h} 时 ${mm} 分` : `${h} 时`;
}
// 格式化进度（p2/10 → 第 2/10 页）
function fmtProg(p) {
  if (!p) return '—';
  const m = String(p).match(/p(\d+)\/(\d+)/);
  return m ? `第 ${m[1]}/${m[2]} 页` : esc(p);
}

window.showLogs = async (id) => {
  const r = await fetch(`/api/admin/${token}/share/${id}/viewers`); const d = await r.json();
  const v = d.viewers || [];
  if (!v.length) { $('#logsBody').innerHTML = '<p class="sub">暂无访问记录</p>'; $('#logsModal').classList.add('show'); return; }
  const totalViewers = v.length;
  const totalReads = v.reduce((a, b) => a + (b.opens || 0), 0);
  const durs = v.map(x => x.durationSec || 0);
  const avgDur = Math.round(durs.reduce((a, b) => a + b, 0) / totalViewers);
  const maxDur = Math.max(...durs, 0);
  $('#logsBody').innerHTML = `
    <div class="vsum">
      <div class="vsum-i"><b>${totalViewers}</b><span>查看人数</span></div>
      <div class="vsum-i"><b>${totalReads}</b><span>阅读次数</span></div>
      <div class="vsum-i"><b>${fmtDur(avgDur)}</b><span>平均时长</span></div>
      <div class="vsum-i"><b>${fmtDur(maxDur)}</b><span>最长时长</span></div>
    </div>
    <div class="vlist">
      ${v.map(x => {
        const loc = [x.country, x.region, x.city].filter(Boolean).join('·') || '—';
        const dev = [x.device, x.os].filter(Boolean).join('/');
        const first = new Date(x.firstAt).toLocaleString();
        const last = new Date(x.lastAt).toLocaleString();
        return `<div class="vcard">
          <div class="vtop">
            <div class="vid">查看者 <b>${esc(x.viewerToken.slice(0, 8))}</b></div>
            <div class="vdur">${fmtDur(x.durationSec)}</div>
          </div>
          <div class="vmeta"><span>阅读 ${x.opens} 次</span><span>进度 ${fmtProg(x.lastProgress)}</span></div>
          <div class="vdev">${esc(dev || '—')} · ${esc(x.browser || '—')}</div>
          <div class="vsub">${esc(x.ip || '—')} · ${esc(loc)}</div>
          <div class="vtime">首次 ${first} · 最近 ${last}</div>
        </div>`;
      }).join('')}
    </div>
    <p class="sub" style="margin-top:12px">注：阅读时长按访问事件间隔累加（单次离开超过 5 分钟不计）；IP 与地理位置可能受代理 / 移动网络影响，内网访问标记为「内网/局域网」。</p>`;
  $('#logsModal').classList.add('show');
};
window.destroy = async (id) => {
  await fetch(`/api/admin/${token}/share/${id}/destroy`, { method: 'POST' });
  toast('已远程销毁');
  mineShares = mineShares.map(s => s.shareId === id ? { ...s, status: 'destroyed' } : s);
  renderMineGrid();
};
window.restore = async (id) => {
  await fetch(`/api/admin/${token}/share/${id}/restore`, { method: 'POST' });
  toast('已恢复');
  mineShares = mineShares.map(s => s.shareId === id ? { ...s, status: 'active' } : s);
  renderMineGrid();
};
// 彻底删除分享：清理配置链接、访问记录、授权、会话；文件若未被其他分享引用则一并删除
window.deleteShare = async (id) => {
  const s = mineShares.find(x => x.shareId === id);
  const name = s ? s.name : '该分享';
  if (!(await confirmDialog(`确定彻底删除「${name}」？\n分享链接将失效，所有访问记录、授权记录会被清理；若文件未被其他分享引用，文件本身也会一并删除。`, { danger: true, title: '删除分享' }))) return;
  const r = await fetch(`/api/admin/${token}/share/${id}`, { method: 'DELETE' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alertDialog('删除失败：' + (d.message || r.statusText), { title: '错误' });
    return;
  }
  toast('已删除分享');
  mineShares = mineShares.filter(s => s.shareId !== id);
  renderMineGrid();
};

// ============ 批量操作（我的分享） ============
// 统一走 /api/admin/:token/shares/batch：一个请求处理整批，服务端逐条鉴权并返回 updatedIds/denied/failed。
async function postBatch(action, settings) {
  const shareIds = Array.from(selectedShareIds);
  if (!shareIds.length) return null;
  const body = { action, shareIds };
  if (settings) body.settings = settings;
  const r = await fetch(`/api/admin/${token}/shares/batch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { alertDialog('操作失败：' + (d.message || d.error || r.statusText), { title: '错误' }); return null; }
  if (d.failed && d.failed.length) console.warn('[batch] 部分失败', d.failed);
  return d;
}
// 把服务端返回的遣返数量拼成一句提示后缀，避免"看起来全成功了"的误导
function batchSuffix(d) {
  const bits = [];
  if (d.denied && d.denied.length) bits.push(`${d.denied.length} 个无权限已跳过`);
  if (d.failed && d.failed.length) bits.push(`${d.failed.length} 个失败`);
  return bits.length ? `（${bits.join('，')}）` : '';
}
window.bulkShareStatus = async (action) => {
  const n = selectedShareIds.size;
  if (!n) return;
  const isDestroy = action === 'destroy';
  if (isDestroy && !(await confirmDialog(
    `确定远程销毁选中的 ${n} 个分享？\n销毁后链接立即失效，访客无法再打开；之后随时可以「批量恢复」。`,
    { danger: true, title: '批量销毁', okText: '销毁' }))) return;
  const d = await postBatch(action);
  if (!d) return;
  const st = isDestroy ? 'destroyed' : 'active';
  const done = new Set(d.updatedIds || []);
  mineShares = mineShares.map(s => done.has(s.shareId) ? { ...s, status: st } : s);
  renderMineGrid();  // 保留选中集，方便接着做下一个批量动作
  toast(`已${isDestroy ? '销毁' : '恢复'} ${d.updated} 个分享` + batchSuffix(d));
};
window.bulkDeleteShares = async () => {
  const n = selectedShareIds.size;
  if (!n) return;
  const names = mineShares.filter(s => selectedShareIds.has(s.shareId)).map(s => '「' + s.name + '」');
  const preview = names.slice(0, 5).join('、') + (names.length > 5 ? ` 等 ${names.length} 个` : '');
  if (!(await confirmDialog(
    `确定彻底删除选中的 ${n} 个分享？\n\n${preview}\n\n分享链接将失效，访问记录与授权记录一并清理；若文件未被其他分享引用，文件本身也会删除。此操作不可撤销。`,
    { danger: true, title: '批量删除', okText: '彻底删除' }))) return;
  const ids = Array.from(selectedShareIds);
  const d = await postBatch('delete');
  if (!d) return;
  const done = new Set(d.updatedIds || []);
  mineShares = mineShares.filter(s => !done.has(s.shareId));
  done.forEach(id => selectedShareIds.delete(id));
  renderMineGrid();
  toast(`已删除 ${d.updated} 个分享` + (d.filesDeleted ? `，清理文件 ${d.filesDeleted} 个` : '') + batchSuffix(d));
};
window.bulkCopyLinks = () => {
  const links = mineShares.filter(s => selectedShareIds.has(s.shareId)).map(s => location.origin + s.link);
  if (!links.length) return;
  navigator.clipboard.writeText(links.join('\n'));
  toast(`已复制 ${links.length} 条链接`);
};
// 批量改权限弹窗：所有字段默认「不修改」，只提交被真正触碰过的键。
window.bulkEditShares = () => {
  const n = selectedShareIds.size;
  if (!n) return;
  const opts = [['1', '1 天'], ['3', '3 天'], ['7', '7 天'], ['30', '30 天']]
    .map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('#bulkBody').innerHTML = `
    <p class="sub bk-tip">已选中 <b>${n}</b> 个分享。只有你实际填写或选择的项会被修改，其余各项保持各自原样。</p>
    <div class="edit-grid">
      <div class="efield egrid-2">
        <div class="ef-hd"><label>有效期</label><i>不选=不修改</i></div>
        <select id="bExpire">
          <option value="keep">不修改</option>
          <option value="0">永久有效</option>
          ${opts}
          <option value="custom">自定义时间</option>
        </select>
        <input type="datetime-local" id="bExpireCustom" style="display:none;margin-top:6px" />
      </div>
      <div class="efield"><div class="ef-hd"><label>最大人数</label><i>留空不修改</i></div>
        <input id="bMV" type="number" min="0" placeholder="0 = 不限"></div>
      <div class="efield"><div class="ef-hd"><label>最大次数</label><i>留空不修改</i></div>
        <input id="bMO" type="number" min="0" placeholder="0 = 不限"></div>
      <div class="efield"><div class="ef-hd"><label>单次时长</label><i>分钟，留空不修改</i></div>
        <input id="bDur" type="number" min="0" placeholder="0 = 不限"></div>
      <div class="efield egrid-2"><div class="ef-hd"><label>内容保护</label><i>不选=不修改</i></div>
        <select id="bProtect">
          <option value="keep">不修改</option>
          <option value="on">全部开启（禁复制 / 禁打印 / 禁下载 / 防截图）</option>
          <option value="off">全部关闭</option>
        </select></div>
    </div>
    <p class="sub bk-note">访问码、水印、验证方式每个分享各不相同，批量模式下不提供修改，需要时请单独「改权限」。</p>`;
  const sel = $('#bExpire');
  sel.addEventListener('change', () => { $('#bExpireCustom').style.display = sel.value === 'custom' ? 'block' : 'none'; });
  $('#bulkModal').classList.add('show');
};
$('#saveBulk').onclick = async () => {
  const s = {};
  const ev = $('#bExpire').value;
  if (ev === 'custom') {
    const dt = new Date($('#bExpireCustom').value || 0).getTime();
    if (!dt || dt <= Date.now()) { toast('请选择未来的时间'); return; }
    s.expiresAt = dt;
  } else if (ev !== 'keep') {
    s.expiresAt = Number(ev) > 0 ? Date.now() + Number(ev) * 86400000 : null;
  }
  const num = (sel, key, mul) => {
    const v = $(sel).value.trim();
    if (v !== '') s[key] = Math.max(0, parseInt(v, 10) || 0) * (mul || 1);
  };
  num('#bMV', 'maxViewers');
  num('#bMO', 'maxViews');
  num('#bDur', 'durationSec', 60);
  const pv = $('#bProtect').value;
  if (pv === 'on') { s.disableCopy = s.disablePrint = s.disableDownload = s.disableScreenshot = true; }
  else if (pv === 'off') { s.disableCopy = s.disablePrint = s.disableDownload = s.disableScreenshot = false; }
  if (!Object.keys(s).length) { toast('没有要修改的项'); return; }
  const d = await postBatch('settings', s);
  if (!d) return;
  $('#bulkModal').classList.remove('show');
  // 乐观更新：只把本次提交的键写回本地缓存，未触碰的字段保持原值
  const done = new Set(d.updatedIds || []);
  mineShares = mineShares.map(x => done.has(x.shareId) ? applySettingsLocal(x, s) : x);
  renderMineGrid();
  toast(`已更新 ${d.updated} 个分享的权限` + batchSuffix(d));
};
function applySettingsLocal(x, s) {
  const n = { ...x };
  ['maxViewers', 'maxViews', 'durationSec', 'expiresAt', 'accessCode', 'authMode', 'watermark']
    .forEach(k => { if (k in s) n[k] = s[k]; });
  const r = { ...(x.restrictions || {}) };
  if ('disableCopy' in s) r.copy = s.disableCopy;
  if ('disablePrint' in s) r.print = s.disablePrint;
  if ('disableDownload' in s) r.download = s.disableDownload;
  if ('disableScreenshot' in s) r.screenshot = s.disableScreenshot;
  n.restrictions = r;
  return n;
}

let editId = null;
window.editShare = async (id) => {
  editId = id;
  const r = await fetch(`/api/admin/${token}`); const d = await r.json();
  const s = d.shares.find(x => x.shareId === id);
  const extra = s.extra || {};
  const pp = Number(extra.previewPages) || 0;
  const pEnabled = pp > 0;
  // 有效期：判断是预设还是自定义
  let expSelect = '0', expCustom = '';
  if (s.expiresAt) {
    const preset = [1,3,7,30].find(n => Math.abs(s.expiresAt - (Date.now() + n * 86400000)) < 3600000);
    if (preset) expSelect = String(preset);
    else { expSelect = 'custom'; expCustom = new Date(s.expiresAt).toISOString().slice(0, 16); }
  }
  // 布局（紧凑版）：三列网格 7 字段压成 2 行 + 水印整行 → 内容保护四项一行 → 试看限制单行内联
  $('#editBody').innerHTML = `
    <div class="edit-grid">
      <div class="efield egrid-2">
        <div class="ef-hd"><label>有效期</label></div>
        <select id="eExpire">
          <option value="0" ${expSelect==='0'?'selected':''}>永久有效</option>
          <option value="1" ${expSelect==='1'?'selected':''}>1 天</option>
          <option value="3" ${expSelect==='3'?'selected':''}>3 天</option>
          <option value="7" ${expSelect==='7'?'selected':''}>7 天</option>
          <option value="30" ${expSelect==='30'?'selected':''}>30 天</option>
          <option value="custom" ${expSelect==='custom'?'selected':''}>自定义时间</option>
        </select>
        <input type="datetime-local" id="eExpireCustom" value="${esc(expCustom)}" style="display:${expSelect==='custom'?'block':'none'};margin-top:6px" />
      </div>
      <div class="efield">
        <div class="ef-hd"><label>访问码</label><i>留空不设</i></div>
        <input id="eCode" value="${s.accessCode || ''}" placeholder="访客需输入才可查看" />
      </div>
      <div class="efield">
        <div class="ef-hd"><label>验证方式</label></div>
        <select id="eAuth"><option value="open" ${s.authMode==='open'?'selected':''}>公开</option><option value="approve" ${s.authMode==='approve'?'selected':''}>申请授权</option></select>
      </div>
      <div class="efield">
        <div class="ef-hd"><label>最大人数</label><i>0 = 不限</i></div>
        <input id="eMV" type="number" value="${s.maxViewers}">
      </div>
      <div class="efield">
        <div class="ef-hd"><label>最大次数</label><i>0 = 不限</i></div>
        <input id="eMO" type="number" value="${s.maxViews}">
      </div>
      <div class="efield">
        <div class="ef-hd"><label>单次时长</label><i>分钟，0 = 不限</i></div>
        <input id="eDur" type="number" value="${Math.round(s.durationSec/60)}">
      </div>
      <div class="efield egrid-2">
        <div class="ef-hd"><label>水印</label><i>留空不显示</i></div>
        <input id="eWm" value="${esc(s.watermark)}" placeholder="如：济宁佳印图文 看样文件" />
      </div>
    </div>

    <div class="esec">内容保护</div>
    <div class="edit-checks">
      <label><input type="checkbox" id="eCopy" ${s.restrictions.copy?'checked':''}>禁复制</label>
      <label><input type="checkbox" id="ePrint" ${s.restrictions.print?'checked':''}>禁打印</label>
      <label><input type="checkbox" id="eDl" ${s.restrictions.download?'checked':''}>禁下载</label>
      <label><input type="checkbox" id="eSc" ${s.restrictions.screenshot?'checked':''}>防截图</label>
    </div>

    <div class="esec esec-sw">
      <span class="et">试看限制</span><span class="hint">仅 PDF / Word 生效</span><i class="ln"></i>
      <label class="esw" title="开启后可限制访客只能试看前几页"><input type="checkbox" id="ePreview" ${pEnabled?'checked':''}><span>启用</span></label>
    </div>
    <div class="eprev" id="ePrevBox">
      <div class="pbody">
        <div class="prow"><span>允许预览前</span><input id="ePPages" type="number" min="1" value="${pEnabled?pp:2}" /><span>页</span></div>
        <div class="prow"><span>超出后需密码</span><input id="ePPwd" type="text" value="${esc(extra.protectPassword||'')}" placeholder="留空则不可看" autocomplete="off" /><span>才能查看</span></div>
      </div>
    </div>`;
  const eExpire = document.getElementById('eExpire');
  if (eExpire) eExpire.addEventListener('change', () => {
    const ec = document.getElementById('eExpireCustom');
    if (ec) ec.style.display = eExpire.value === 'custom' ? 'block' : 'none';
  });
  // 未启用试看限制时，下面的参数行置灰不可操作（仍保留已填内容）
  const ePrev = document.getElementById('ePreview'), ePrevBox = document.getElementById('ePrevBox');
  const syncPrev = () => { if (ePrevBox) ePrevBox.classList.toggle('off', !(ePrev && ePrev.checked)); };
  if (ePrev) ePrev.addEventListener('change', syncPrev);
  syncPrev();
  $('#editModal').classList.add('show');
};
$('#saveEdit').onclick = async () => {
  const eExpire = $('#eExpire');
  let expiresAt = null;
  if (eExpire && eExpire.value === 'custom') {
    const v = $('#eExpireCustom').value;
    const dt = v ? new Date(v).getTime() : 0;
    if (dt > Date.now()) expiresAt = dt;
  } else {
    const expVal = parseInt(eExpire ? eExpire.value : '0', 10) || 0;
    if (expVal > 0) expiresAt = Date.now() + expVal * 86400000;
  }
  const previewEnabled = $('#ePreview').checked;
  const previewPages = previewEnabled ? (parseInt($('#ePPages').value, 10) || 2) : 0;
  const protectPassword = previewEnabled ? ($('#ePPwd').value.trim() || null) : null;
  const extra = { previewPages };
  if (protectPassword) extra.protectPassword = protectPassword;
  const body = {
    maxViewers: parseInt($('#eMV').value, 10) || 0, maxViews: parseInt($('#eMO').value, 10) || 0,
    durationSec: (parseInt($('#eDur').value, 10) || 0) * 60, accessCode: $('#eCode').value.trim() || null,
    authMode: $('#eAuth').value, watermark: $('#eWm').value.trim(),
    disableCopy: $('#eCopy').checked, disablePrint: $('#ePrint').checked,
    disableDownload: $('#eDl').checked, disableScreenshot: $('#eSc').checked,
    expiresAt,
    extra
  };
  await fetch(`/api/admin/${token}/share/${editId}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('#editModal').classList.remove('show'); toast('权限已更新');
  // 乐观更新：把新权限写回本地缓存并重渲染，不重新拉取整表
  mineShares = mineShares.map(s => s.shareId === editId ? {
    ...s, maxViewers: body.maxViewers, maxViews: body.maxViews, durationSec: body.durationSec,
    accessCode: body.accessCode, authMode: body.authMode, watermark: body.watermark, expiresAt: body.expiresAt,
    restrictions: { copy: body.disableCopy, print: body.disablePrint, download: body.disableDownload, screenshot: body.disableScreenshot },
    extra: body.extra
  } : s);
  renderMineGrid();
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

// 后台预载默认标签（与 initOrg 的 me 请求并发），避免首屏串行等待；panelLoaded 标记防止 switchTab 重复拉取
if (!panelLoaded.mine) { load(); panelLoaded.mine = true; }

// ---------- 店长（组织）后台 ----------
const orgToken = localStorage.getItem('userToken');
// 登录后选择所属门店（取代“按邮箱域名自动分配门店”的旧逻辑）
async function showStorePicker() {
  let orgs = [];
  try {
    const r = await fetch('/api/orgs?userToken=' + encodeURIComponent(token), { cache: 'no-store' });
    const d = await r.json();
    orgs = d.orgs || [];
  } catch (e) { orgs = []; }
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'storePicker';
  if (!orgs.length) {
    modal.innerHTML = `<div class="box" style="max-width:420px;text-align:left;">
      <div class="dlg-title">尚未创建门店</div>
      <div class="dlg-msg">当前还没有可供加入的门店，请联系管理员先在后台创建门店。</div>
      <div class="dlg-acts"><button class="btn" id="sp_close">我知道了</button></div>
    </div>`;
  } else {
    modal.innerHTML = `<div class="box" style="max-width:420px;text-align:left;">
      <div class="dlg-title">选择您的门店</div>
      <div class="sub" style="margin:4px 0 12px">请选择您所属的门店，加入后即可创建与分享文件。</div>
      <div id="spList" style="display:flex;flex-direction:column;gap:8px;max-height:52vh;overflow:auto;"></div>
    </div>`;
  }
  document.body.appendChild(modal);
  modal.classList.add('show');
  const close = () => { modal.classList.remove('show'); setTimeout(() => modal.remove(), 200); };
  if (!orgs.length) {
    modal.querySelector('#sp_close').onclick = close;
  } else {
    const list = modal.querySelector('#spList');
    orgs.forEach(o => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = o.name;
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '加入中…';
        try {
          const rr = await fetch('/api/auth/join-org', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userToken: token, orgId: o.id }) });
          const dd = await rr.json();
          if (dd.ok) { close(); toast('已加入门店：' + dd.orgName); setTimeout(() => location.reload(), 250); }
          else { btn.disabled = false; btn.textContent = o.name; alertDialog(dd.message || '加入失败，请重试'); }
        } catch (e) { btn.disabled = false; btn.textContent = o.name; alertDialog('网络异常，请重试'); }
      };
      list.appendChild(btn);
    });
  }
}
async function initOrg() {
  if (!orgToken) return;
  try { const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(orgToken)); meState = await r.json(); }
  catch (e) { return; }
  if (!meState) return;
  // 取消“按邮箱域名自动分配门店”：未归属门店的普通用户，登录后弹出选择门店
  if (!meState.orgId && !meState.isSuper) { showStorePicker(); }

  const tabs = $('#tabs');
  tabs.style.display = 'flex';
  if (meState.role === 'admin') {
    document.querySelectorAll('.tab[data-tab="org"], .tab[data-tab="members"], .tab[data-tab="invite"]').forEach(el => el.style.display = '');
  } else {
    document.querySelectorAll('.tab[data-tab="org"], .tab[data-tab="members"], .tab[data-tab="invite"]').forEach(el => el.style.display = 'none');
  }
  if (meState.isSuper) { $('#tabAllShares').style.display=''; $('#tabStats').style.display=''; $('#tabDashboard').style.display=''; $('#tabUsers').style.display=''; $('#tabAudit').style.display=''; $('#tabStores').style.display=''; }

  $('#genInvite').addEventListener('click', async () => {
    const r = await fetch('/api/org/invite?userToken=' + encodeURIComponent(orgToken), { method: 'POST' });
    const d = await r.json();
    if (d.code) { const c = $('#inviteCode'); c.textContent = '邀请码：' + d.code; c.style.display = 'inline-block'; toast('已生成：' + d.code); }
  });
}

// ---------- 全局标签切换（无刷新；创建分享/设置已合并进本页） ----------
const superTabs = ['allshares', 'stats', 'dashboard', 'users', 'audit', 'stores'];
function highlightSideNav(t) {
  document.querySelectorAll('#sideNav a').forEach(a => a.classList.remove('active'));
  let key = 'mine';
  if (t === 'create') key = 'create';
  else if (t === 'settings') key = 'settings';
  else if (t === 'files') key = 'files';
  else if (superTabs.includes(t) || ['org', 'members', 'invite'].includes(t)) key = 'super';
  const a = document.querySelector(`#sideNav a[data-key="${key}"]`);
  if (a) a.classList.add('active');
}
function hideAllPanels() {
  ['list', 'orgPanel', 'superPanel', 'filesPanel', 'dashboardPanel', 'createPanel', 'settingsPanel']
    .forEach(k => { const el = $('#' + k); if (el) el.style.display = 'none'; });
}
function switchTab(t) {
  const adminTabs = ['org','members','invite','allshares','stats','dashboard','users','audit'];
  const crumb = $('#pageCrumb');
  const crumbMap = { create:'创建分享', mine:'我的分享', files:'文件管理', settings:'设置', dashboard:'数据概览', org:'全店分享', members:'全店分享', invite:'全店分享', stores:'门店管理' };
  const crumbText = crumbMap[t] || (adminTabs.includes(t) ? '管理后台' : '工作台');
  if (crumb) crumb.textContent = crumbText;
  document.title = '安阅 · ' + crumbText;
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.tab[data-tab="${t}"]`);
  if (btn) btn.classList.add('active');
  // 离开「我的分享」就退出批量模式并清空选中，避免切回来时残留勾选框/选中态
  if (t !== 'mine' && selMode) { selMode = false; selectedShareIds.clear(); }
  hideAllPanels();
  if (superTabs.includes(t)) {
    $('#superPanel').style.display = 'block';
    $('#superAllShares').style.display = t === 'allshares' ? 'block' : 'none';
    $('#superStats').style.display = t === 'stats' ? 'block' : 'none';
    $('#superUsers').style.display = t === 'users' ? 'block' : 'none';
    $('#superAudit').style.display = t === 'audit' ? 'block' : 'none';
    $('#superStores').style.display = t === 'stores' ? 'block' : 'none';
    if (t === 'allshares' && !panelLoaded.allshares) { loadAllShares(); panelLoaded.allshares = true; }
    if (t === 'stats' && !panelLoaded.stats) { loadStats(); panelLoaded.stats = true; }
    if (t === 'users' && !panelLoaded.users) { loadUsers(); panelLoaded.users = true; }
    if (t === 'audit' && !panelLoaded.audit) { loadAudit(); panelLoaded.audit = true; }
    if (t === 'stores' && !panelLoaded.stores) { loadStores(); panelLoaded.stores = true; }
  } else if (t === 'mine') {
    $('#list').style.display = 'block';
    // 已加载过也要重渲染一次：上面的状态复位（退出批量模式）需要反映到 DOM 上
    if (!panelLoaded.mine) { load(); panelLoaded.mine = true; } else { renderMineGrid(); }
  } else if (t === 'files') {
    $('#filesPanel').style.display = 'block';
    if (!panelLoaded.files) { loadFiles(); panelLoaded.files = true; }
  } else if (t === 'dashboard') {
    $('#dashboardPanel').style.display = 'block';
    if (!panelLoaded.dashboard) { loadDashboard(); panelLoaded.dashboard = true; }
  } else if (t === 'create') {
    $('#createPanel').style.display = 'block';
    applySharePrefs();
    checkStore();
  } else if (t === 'settings') {
    $('#settingsPanel').style.display = 'block';
    initSettings();
  } else {
    $('#orgPanel').style.display = 'block';
    $('#orgShares').style.display = t === 'org' ? 'block' : 'none';
    $('#orgMembers').style.display = t === 'members' ? 'block' : 'none';
    $('#orgInvite').style.display = t === 'invite' ? 'block' : 'none';
    if (t === 'org' && !panelLoaded.org) { loadOrgShares(); panelLoaded.org = true; }
    if (t === 'members' && !panelLoaded.members) { loadMembers(); panelLoaded.members = true; }
  }
  highlightSideNav(t);
}
// 顶部 tab 点击
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tab;
    if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
    switchTab(t);
  });
});
// 侧边栏内链（创建分享/我的分享/文件管理/管理后台/设置）全部在 admin.html 内，无刷新切换
document.querySelectorAll('#sideNav a[data-key]').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    let t = a.dataset.key;
    if (t === 'super') t = (meState && meState.isSuper) ? 'allshares' : 'org';
    if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
    switchTab(t);
  });
});
// 顶部「＋新建分享」按钮
const btnNewShare = document.getElementById('btnNewShare');
if (btnNewShare) btnNewShare.addEventListener('click', () => { history.replaceState(null, '', '#create'); switchTab('create'); });
// 根据 URL hash 初始化 tab；默认 mine
const initTab = location.hash.replace('#', '') || 'mine';
switchTab(initTab);
window.addEventListener('hashchange', () => switchTab(location.hash.replace('#', '') || 'mine'));

function renderShares(container, shares, withOwner, own) {
  if (!shares || !shares.length) { container.innerHTML = '<div class="empty">暂无分享</div>'; return; }
  shares.forEach(s => shareById.set(s.shareId, { s, own }));
  container.innerHTML = (withOwner ? `<div class="card-grid with-owner">` : `<div class="card-grid">`) +
    shares.map(s => {
      const card = shareCardHtml(s, own);
      return withOwner ? card.replace('<div class="badge">', `<div class="badge owner">${esc(s.ownerEmail || '匿名')}</div><div class="badge">`) : card;
    }).join('') + `</div>`;
  bindCtxMenus();
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
  if (!d.members || !d.members.length) { box.innerHTML = '<div class="empty">暂无成员</div>'; return; }
  box.innerHTML = `<p class="sub" style="margin-bottom:8px">点击任意成员可查看其分享记录与访问日志，并可直接修改其分享权限。</p>
    <table class="vt"><tr><th>邮箱</th><th>姓名</th><th>角色</th><th>加入时间</th></tr>${d.members.map(m => `<tr class="clickable" onclick="openMemberDetail('${m.id}')" style="cursor:pointer">
      <td>${esc(m.email)}</td><td>${esc(m.realName || '—')}</td><td>${m.role === 'admin' ? '店长' : '员工'}</td><td>${new Date(m.createdAt).toLocaleString()}</td></tr>`).join('')}</table>`;
}
// 店长：查看本店成员分享与日志明细
window.openMemberDetail = async (memberId) => {
  const r = await fetch(`/api/org/members/${memberId}/detail?userToken=` + encodeURIComponent(orgToken));
  const d = await r.json();
  if (d.error) { alertDialog(d.message || '无权查看'); return; }
  const m = d.member || {};
  const shares = (d.shares || []).map(s => `<div class="share-item" style="margin-bottom:8px">
    <div class="meta">${esc(s.name)} · 打开 ${s.opens} 次 · 访客 ${s.viewers} 人${s.status !== 'active' ? ' · <span class="tag off">已销毁</span>' : ''}</div>
    <div class="acts"><a class="btn ghost sm" href="${location.origin}${s.link}" target="_blank">预览</a>
    <button class="btn ghost sm" onclick="editShare('${s.shareId}')">改权限</button>
    <button class="btn ghost sm" onclick="showLogs('${s.shareId}')">访问记录</button></div></div>`).join('') || '<p class="sub">该成员暂无分享</p>';
  const viewers = (d.viewers || []).map(v => `<div class="vcard"><div class="vtop"><div class="vid">查看者 <b>${esc(v.viewerToken.slice(0,8))}</b></div><div class="vdur">${fmtDur(v.durationSec)}</div></div>
    <div class="vmeta"><span>阅读 ${v.opens} 次</span></div>
    <div class="vsub">${esc(v.ip || '—')} · ${[v.country, v.region, v.city].filter(Boolean).join('·') || '—'}</div></div>`).join('') || '<p class="sub">暂无访客</p>';
  const logs = (d.logs || []).map(l => `<div class="log-row">${new Date(l.createdAt).toLocaleString()} · ${esc(l.shareName)} · 事件 ${esc(l.event)}${l.progress ? ' · ' + esc(l.progress) : ''}</div>`).join('') || '<p class="sub">暂无日志</p>';
  $('#memberModalTitle').textContent = `成员：${esc(m.realName || m.email || '')}`;
  $('#memberModalBody').innerHTML = `
    <div class="vsum"><div class="vsum-i"><b>${(d.shares||[]).length}</b><span>分享数</span></div><div class="vsum-i"><b>${(d.viewers||[]).length}</b><span>访客数</span></div><div class="vsum-i"><b>${(d.logs||[]).length}</b><span>日志条数</span></div></div>
    <h3 style="margin-top:14px">分享记录</h3>${shares}
    <h3 style="margin-top:14px">访客</h3><div class="vlist">${viewers}</div>
    <h3 style="margin-top:14px">访问日志</h3><div class="log-list">${logs}</div>`;
  $('#memberModal').classList.add('show');
};

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
    if (!(await confirmDialog('确定清理孤儿文件？此操作不可恢复。', { danger: true }))) return;
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
  await loadOrgsCache();
  const orgOpts = (sel) => `<option value="">（无门店）</option>` + allOrgs.map(o => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
  const rows = (d.users || []).map(u => {
    const tags = [u.isSuper ? '<span class="tag on">超级管理员</span>' : '', u.role === 'admin' ? '<span class="tag on">店长</span>' : '', u.disabled ? '<span class="tag off">已禁用</span>' : ''].join(' ');
    const acts = [
      u.disabled ? `<button class="btn ghost sm" onclick="userAct('${u.id}','enable')">启用</button>` : `<button class="btn ghost sm" onclick="userAct('${u.id}','disable')">禁用</button>`,
      `<button class="btn ghost sm" onclick="userAct('${u.id}','role',${u.role === 'admin' ? '\'member\'' : '\'admin\''})">${u.role === 'admin' ? '降为员工' : '设为店长'}</button>`,
      `<button class="btn ghost sm" onclick="userAct('${u.id}','super',${u.isSuper ? 'false' : 'true'})">${u.isSuper ? '取消超管' : '设为超管'}</button>`,
      `<button class="btn danger sm" onclick="userAct('${u.id}','delete')">删除</button>`
    ].join(' ');
    return `<tr><td>${esc(u.email)} ${tags}</td><td>${fmtBytes(u.bytes)}</td><td>${u.shareCount}</td>
      <td><select class="org-sel" onchange="assignUserOrg('${u.id}', this.value, '${u.role === 'admin' ? 'admin' : 'member'}')">${orgOpts(u.orgId)}</select></td>
      <td>${new Date(u.createdAt).toLocaleString()}</td><td>${acts}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="sub">暂无用户</td></tr>';
  $('#superUsers').innerHTML = `<div class="card"><h2>注册用户（${d.users.length}）</h2>
    <table class="vt"><tr><th>邮箱</th><th>占用</th><th>分享数</th><th>所属门店</th><th>注册时间</th><th>操作</th></tr>${rows}</table>
    <p class="sub" style="margin-top:8px">禁用后该账号无法登录；删除会同时清除其所有分享与文件；在「所属门店」下拉可直接将用户分配到门店并设定角色。</p></div>`;
}
window.userAct = async (id, action, val) => {
  let body = null, confirmMsg = null;
  if (action === 'delete') confirmMsg = '确定删除该用户及其所有分享/文件？不可恢复！';
  else if (action === 'disable') confirmMsg = '确定禁用该账号？';
  if (confirmMsg && !(await confirmDialog(confirmMsg, { danger: true }))) return;
  if (action === 'role') body = JSON.stringify({ role: val });
  if (action === 'super') body = JSON.stringify({ super: val });
  const r = await fetch(`/api/super/user/${id}/${action}?userToken=` + encodeURIComponent(orgToken), {
    method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : {}, body
  });
  const d = await r.json();
  toast(d.ok ? '操作成功' : (d.message || '操作失败'));
  loadUsers();
};
// ========== 门店管理（超级管理员） ==========
let allOrgs = [];           // 门店缓存，供用户管理分配下拉复用
let orgNameMap = {};
async function loadOrgsCache() {
  if (!allOrgs.length) {
    try {
      const r = await fetch('/api/super/orgs?userToken=' + encodeURIComponent(orgToken));
      const d = await r.json();
      if (d.orgs) { allOrgs = d.orgs; orgNameMap = {}; d.orgs.forEach(o => { orgNameMap[o.id] = o.name; }); }
    } catch (e) { /* 忽略，下次重试 */ }
  }
  return allOrgs;
}
async function loadStores() {
  const box = $('#superStores');
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>门店管理</h2>
    <div class="store-bar">
      <input id="newStoreName" placeholder="输入新门店名称，如：济宁旗舰店" />
      <button class="btn sm" id="addStoreBtn">＋ 新建门店</button>
    </div>
    <p class="sub" style="margin:6px 0 10px">超级管理员统一创建门店、指派店长与成员。新注册用户须由超管分配门店后才能创建分享；店长可查看本店成员的分享与日志。</p>
    <div id="storeList"><p class="sub">加载中…</p></div>
  </div>`;
  const addBtn = document.getElementById('addStoreBtn');
  if (addBtn) addBtn.onclick = async () => {
    const name = document.getElementById('newStoreName').value.trim();
    if (!name) return toast('请输入门店名称');
    const r = await fetch('/api/super/org?userToken=' + encodeURIComponent(orgToken), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return toast('失败：' + (d.message || r.statusText));
    toast('已创建门店：' + name); document.getElementById('newStoreName').value = '';
    allOrgs = []; loadStores();
  };
  await renderStoreList();
}
async function renderStoreList() {
  const wrap = document.getElementById('storeList');
  if (!wrap) return;
  wrap.innerHTML = '<p class="sub">加载中…</p>';
  try {
    const r = await fetch('/api/super/orgs?userToken=' + encodeURIComponent(orgToken));
    const d = await r.json();
    if (d.error) { wrap.innerHTML = '<div class="empty">无权访问</div>'; return; }
    const orgs = d.orgs || [];
    allOrgs = orgs; orgNameMap = {}; orgs.forEach(o => { orgNameMap[o.id] = o.name; });
    if (!orgs.length) { wrap.innerHTML = '<div class="empty">还没有门店，先新建一个吧</div>'; return; }
    wrap.innerHTML = orgs.map(o => `
      <div class="store-card" id="store_${o.id}">
        <div class="store-hd">
          <div class="store-name">${esc(o.name)}</div>
          <div class="store-meta">店长：${o.managerEmail ? esc(o.managerEmail) : '<span class="sub">未指定</span>'} · 成员 ${o.memberCount} 人</div>
        </div>
        <div class="store-acts">
          <button class="btn ghost sm" onclick="renameStore('${o.id}','${esc(o.name)}')">改名</button>
          <button class="btn ghost sm" onclick="toggleStoreMembers('${o.id}')">成员(${o.memberCount})</button>
          <button class="btn danger sm" onclick="deleteStore('${o.id}','${esc(o.name)}')">删除门店</button>
        </div>
        <div class="store-members" id="storeMembers_${o.id}" style="display:none"></div>
      </div>`).join('');
  } catch (e) { wrap.innerHTML = '<div class="empty">加载失败</div>'; }
}
window.renameStore = async (id, oldName) => {
  const name = prompt('修改门店名称', oldName);
  if (!name || !name.trim()) return;
  const r = await fetch('/api/super/org/' + id + '?userToken=' + encodeURIComponent(orgToken), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return toast('失败：' + (d.message || r.statusText));
  toast('已改名'); allOrgs = []; renderStoreList();
};
window.deleteStore = async (id, name) => {
  if (!(await confirmDialog(`确定删除门店「${name}」？\n删除前请先将该门店成员移出或分配到其他门店，删除后该门店的邀请码也会一并清除。`, { danger: true, title: '删除门店' }))) return;
  const r = await fetch('/api/super/org/' + id + '?userToken=' + encodeURIComponent(orgToken), { method: 'DELETE' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return toast('失败：' + (d.message || r.statusText));
  toast('已删除门店'); allOrgs = []; renderStoreList();
};
window.toggleStoreMembers = async (id) => {
  const box = document.getElementById('storeMembers_' + id);
  if (!box) return;
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = '<p class="sub">加载成员中…</p>';
  try {
    const r = await fetch('/api/super/org/' + id + '/members?userToken=' + encodeURIComponent(orgToken));
    const d = await r.json();
    if (d.error) { box.innerHTML = '<div class="empty">无权访问</div>'; return; }
    const ms = d.members || [];
    if (!ms.length) { box.innerHTML = '<p class="sub">该门店暂无成员</p>'; return; }
    box.innerHTML = `<table class="vt"><tr><th>邮箱</th><th>姓名</th><th>角色</th><th>操作</th></tr>${ms.map(m => `
      <tr>
        <td>${esc(m.email)} ${m.isSuper ? '<span class="tag on">超管</span>' : ''}</td>
        <td>${esc(m.realName || '—')}</td>
        <td>${m.role === 'admin' ? '店长' : '员工'}</td>
        <td class="acts-cell">
          ${m.role === 'admin'
            ? `<button class="btn ghost sm" onclick="assignUserOrg('${m.id}','${id}','member')">降为员工</button>`
            : `<button class="btn ghost sm" onclick="assignUserOrg('${m.id}','${id}','admin')">设为店长</button>`}
          <button class="btn danger sm" onclick="assignUserOrg('${m.id}','','member')">移出门店</button>
        </td>
      </tr>`).join('')}</table>`;
  } catch (e) { box.innerHTML = '<div class="empty">加载失败</div>'; }
};
window.assignUserOrg = async (userId, orgId, role) => {
  const r = await fetch(`/api/super/user/${userId}/org?userToken=` + encodeURIComponent(orgToken), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId: orgId || '', role: role || 'member' })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return toast('失败：' + (d.message || r.statusText));
  toast('已更新归属');
  allOrgs = [];
  if ($('#superStores').style.display !== 'none') renderStoreList();
  if ($('#superUsers').style.display !== 'none') loadUsers();
};
// 无门店校验：未归属门店时禁用创建分享并提示
function checkStore() {
  const ns = $('#noStoreNotice');
  const btn = $('#shareBtn');
  if (meState && !meState.orgId) {
    if (ns) ns.style.display = 'block';
    if (btn) btn.disabled = true;
    return false;
  }
  if (ns) ns.style.display = 'none';
  if (btn) btn.disabled = false;
  return true;
}

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
let lastFiles = [];          // 服务端返回的文件缓存，搜索/排序在客户端完成
let fileMap = {};            // fileId -> { name }，供菜单动作取文件名，避免拼接转义问题
let fileSort = { key: 'createdAt', dir: 'desc' };
let selectedFileIds = new Set();
let renameTargetId = null;

async function loadFiles() {
  const box = $('#filesPanel');
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>文件管理</h2>
    <div class="audit-bar">
      <div class="ab grow"><label>搜索文件名</label><input id="fileSearch" placeholder="输入关键词过滤当前列表" /></div>
      <div class="ab grow"><label>按人员筛选（仅超管）</label><input id="fileOwner" placeholder="输入邮箱关键词，如 309953160" ${!isSuperNow() ? 'disabled' : ''} /></div>
      <div class="ab-acts"><button class="btn sm" id="fileRefresh">刷新</button></div>
    </div>
    <div class="file-batchbar" id="fileBatchBar" style="display:none">
      <span id="fileSelCount" class="sub">已选 0 项</span>
      <button class="btn danger sm" id="fileBatchDelete">批量删除</button>
      <button class="btn ghost sm" id="fileClearSel">取消选择</button>
    </div>
    <div id="fileGrid"></div>
    <p class="sub" style="margin-top:10px">说明：替换文件会覆盖原文件内容，但<b>分享链接保持不变</b>，客户始终看到最新文件；仅当文件未被任何生效分享引用时方可删除。可勾选多行批量删除、点击列名排序、用上方搜索框过滤。</p>
  </div>`;
  const search = document.getElementById('fileSearch');
  search.addEventListener('input', () => renderFileGrid());
  const ownerInput = document.getElementById('fileOwner');
  if (ownerInput) ownerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') renderFileGrid(true); });
  document.getElementById('fileRefresh').onclick = () => renderFileGrid(true);
  document.getElementById('fileBatchDelete').onclick = batchDeleteFiles;
  document.getElementById('fileClearSel').onclick = () => { selectedFileIds.clear(); renderFileGrid(); };
  await renderFileGrid(true);
}
async function renderFileGrid(fetchFirst) {
  const grid = document.getElementById('fileGrid');
  if (!grid) return;
  if (fetchFirst) {
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
      lastFiles = d.files || [];
    } catch (e) { grid.innerHTML = '<div class="empty">加载失败</div>'; return; }
  }
  // 客户端搜索 + 排序（不回源，体验更顺滑）
  const q = (document.getElementById('fileSearch') ? document.getElementById('fileSearch').value : '').trim().toLowerCase();
  let rows = lastFiles.filter(f => !q || (f.name || '').toLowerCase().includes(q));
  const { key, dir } = fileSort;
  rows = rows.slice().sort((a, b) => {
    let av, bv;
    if (key === 'name') { av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); }
    else if (key === 'size') { av = Number(a.size) || 0; bv = Number(b.size) || 0; }
    else { av = Number(a.createdAt) || 0; bv = Number(b.createdAt) || 0; }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  fileMap = {};
  rows.forEach(f => { fileMap[f.fileId] = { name: f.name, shareId: f.shareId || null, raw: f }; });
  if (!rows.length) { grid.innerHTML = '<div class="empty">' + (q ? '无匹配文件' : '暂无文件') + '</div>'; updateBatchBar(); return; }
  const superCol = isSuperNow() ? '<th>归属</th>' : '';
  const arrow = (k) => fileSort.key === k ? (fileSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  const head = `<th class="c-sel"><input type="checkbox" id="fileSelAll" title="全选" /></th>
    <th class="sortable" data-key="name">文件名${arrow('name')}</th>
    <th class="sortable" data-key="size">大小${arrow('size')}</th>
    <th class="sortable" data-key="createdAt">上传时间${arrow('createdAt')}</th>
    <th>引用情况</th>${superCol}<th>操作</th>`;
  const body = rows.map(f => {
    const ic = f.kind === 'pdf' ? '📕' : f.kind === 'image' ? '🖼️' : f.kind === 'docx' ? '📘' : '📄';
    const shareCell = f.shareCount > 0
      ? `被 ${f.shareCount} 个分享引用${f.shareName ? '<br>《' + esc(f.shareName) + '》' : ''}`
      : '<span class="danger">未分享（孤儿文件）</span>';
    const ownerCell = f.ownerEmail ? esc(f.ownerEmail) : '';
    const checked = selectedFileIds.has(f.fileId) ? 'checked' : '';
    const menuId = 'fm_' + f.fileId;
    return `<tr data-fid="${f.fileId}">
      <td class="c-sel"><input type="checkbox" class="file-chk" data-fid="${f.fileId}" ${checked} /></td>
      <td class="fn"><span class="fic">${ic}</span>${esc(f.name)}</td>
      <td>${fmtBytes(f.size)}</td>
      <td>${new Date(f.createdAt).toLocaleDateString()}</td>
      <td>${shareCell}</td>
      ${superCol ? `<td>${ownerCell}</td>` : ''}
      <td class="acts-cell">
        <div class="row-menu">
          <button class="btn ghost sm menu-btn" onclick="toggleRowMenu(event,'${menuId}')">更多 ▾</button>
          <div class="menu-list" id="${menuId}">${fileMenuHtml(f)}</div>
        </div>
      </td>
    </tr>`;
  }).join('');
  grid.innerHTML = `<table class="vt file-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  grid.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.key;
    if (fileSort.key === k) fileSort.dir = fileSort.dir === 'asc' ? 'desc' : 'asc';
    else { fileSort.key = k; fileSort.dir = 'asc'; }
    renderFileGrid();
  });
  const selAll = document.getElementById('fileSelAll');
  if (selAll) {
    selAll.checked = rows.length > 0 && rows.every(f => selectedFileIds.has(f.fileId));
    selAll.onchange = () => { rows.forEach(f => { if (selAll.checked) selectedFileIds.add(f.fileId); else selectedFileIds.delete(f.fileId); }); renderFileGrid(); };
  }
  grid.querySelectorAll('.file-chk').forEach(c => c.onchange = () => {
    if (c.checked) selectedFileIds.add(c.dataset.fid); else selectedFileIds.delete(c.dataset.fid);
    const sa = document.getElementById('fileSelAll'); if (sa) sa.checked = rows.length > 0 && rows.every(f => selectedFileIds.has(f.fileId));
    updateBatchBar();
  });
  updateBatchBar();
  bindCtxMenus();
}
// 文件行的可用动作：同样集中定义，行内「更多」与右键菜单共用
function fileMenuItems(f) {
  return [
    { act: 'rename', label: '重命名' },
    { act: 'download', label: '下载' },
    { act: 'previewFile', label: '预览' },
    { act: 'shareFromFile', label: '一键分享' },
    { act: 'replace', label: '替换文件' },
    '-',
    { act: 'deleteFile', label: '删除', danger: true }
  ];
}
function fileMenuHtml(f) {
  return fileMenuItems(f).map(it => it === '-'
    ? '<div class="menu-sep"></div>'
    : `<button class="${it.danger ? 'danger' : ''}" data-act="${it.act}" data-fid="${f.fileId}">${it.label}</button>`
  ).join('');
}
function updateBatchBar() {
  const bar = document.getElementById('fileBatchBar');
  if (!bar) return;
  const n = selectedFileIds.size;
  bar.style.display = n > 0 ? 'flex' : 'none';
  const cnt = document.getElementById('fileSelCount');
  if (cnt) cnt.textContent = '已选 ' + n + ' 项';
}
function isSuperNow() {
  // 通过超管专属 tab 是否可见判断当前会话是否为超管
  const t = document.getElementById('tabUsers');
  return !!(t && t.style.display !== 'none');
}
window.toggleRowMenu = (e, id) => {
  e.stopPropagation();
  document.querySelectorAll('.menu-list.open').forEach(m => { if (m.id !== id) m.classList.remove('open'); });
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
};
document.addEventListener('click', () => {
  document.querySelectorAll('.menu-list.open').forEach(m => m.classList.remove('open'));
});

// ---------- 行内菜单 / 右键菜单的统一动作分发 ----------
// 菜单项只带 data-act + id，具体做什么在这里集中映射；两种菜单共用同一张表。
const MENU_ACT = {
  // 分享
  logs: d => window.showLogs(d.sid),
  edit: d => window.editShare(d.sid),
  approve: d => window.showApprovals(d.sid),
  replace: d => window.replaceFile(d.file || d.fid),
  destroy: d => window.destroy(d.sid),
  restore: d => window.restore(d.sid),
  deleteShare: d => window.deleteShare(d.sid),
  preview: d => window.open(location.origin + '/viewer.html?share=' + d.sid, '_blank', 'noopener'),
  copy: d => window.copyLink(location.origin + '/viewer.html?share=' + d.sid),
  // 文件
  rename: d => window.renameFile(d.fid),
  download: d => window.downloadFile(d.fid),
  previewFile: d => window.previewFile(d.fid),
  shareFromFile: d => window.shareFromFile(d.fid),
  deleteFile: d => window.deleteFile(d.fid)
};
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const fn = MENU_ACT[btn.dataset.act];
  if (!fn) return;
  // 行内菜单点完就收起来（右键菜单由 ctxmenu 自己负责关闭）
  document.querySelectorAll('.menu-list.open').forEach(m => m.classList.remove('open'));
  fn(btn.dataset);
});

// 右键菜单：只挂在列表容器上做事件委托，卡片/行重新渲染也不用重新绑。
// 空白处右键仍然交给浏览器默认菜单（不干扰复制粘贴等常规操作）。
const CTX_SHARE_BOXES = ['list', 'orgShares', 'superAllShares'];
function bindCtxMenus() {
  CTX_SHARE_BOXES.forEach(id => {
    const box = document.getElementById(id);
    if (!box || box.dataset.ctxBound === '1') return;
    box.dataset.ctxBound = '1';
    box.addEventListener('contextmenu', (ev) => {
      const card = ev.target.closest('.share-card');
      if (!card) return;
      const rec = shareById.get(card.dataset.sid);
      if (!rec) return;
      window.showCtxMenu(ev, shareCtxItems(rec.s, rec.own));
    });
  });
  const fg = document.getElementById('fileGrid');
  if (fg && fg.dataset.ctxBound !== '1') {
    fg.dataset.ctxBound = '1';
    fg.addEventListener('contextmenu', (ev) => {
      const tr = ev.target.closest('tr[data-fid]');
      if (!tr) return;
      const f = fileMap[tr.dataset.fid];
      if (!f) return;
      window.showCtxMenu(ev, fileCtxItems(f));
    });
  }
}
// 右键菜单比「更多」多出置顶的「预览 / 复制链接」——这两个在卡片上是常驻按钮，
// 右键时一并给出，符合"右键内容与页面功能一致"的预期。
function shareCtxItems(s, own) {
  const base = shareMenuItems(s, own);
  return [
    { label: '预览', onClick: () => window.open(location.origin + s.link, '_blank', 'noopener') },
    { label: '复制链接', onClick: () => window.copyLink(location.origin + s.link) },
    '-',
    ...base.map(it => it === '-' ? '-' : {
      label: it.label, danger: it.danger,
      onClick: () => MENU_ACT[it.act]({ sid: s.shareId, file: s.fileId, fid: s.fileId })
    })
  ];
}
function fileCtxItems(f) {
  return fileMenuItems(f).map(it => it === '-' ? '-' : {
    label: it.label, danger: it.danger,
    onClick: () => MENU_ACT[it.act]({ fid: f.fileId })
  });
}
window.renameFile = (fileId) => {
  renameTargetId = fileId;
  document.getElementById('renameInput').value = (fileMap[fileId] && fileMap[fileId].name) || '';
  document.getElementById('renameModal').classList.add('show');
  setTimeout(() => { const i = document.getElementById('renameInput'); if (i) i.focus(); }, 50);
};
window.saveRename = async () => {
  if (!renameTargetId) return;
  const name = document.getElementById('renameInput').value.trim();
  if (!name) { toast('文件名不能为空'); return; }
  try {
    const r = await fetch('/api/files/' + renameTargetId + '?userToken=' + encodeURIComponent(orgToken), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || ('重命名失败 HTTP ' + r.status));
    toast('✅ 已重命名');
    const f = lastFiles.find(x => x.fileId === renameTargetId); if (f) { f.name = name; f.originalName = name; }
    document.getElementById('renameModal').classList.remove('show');
    renderFileGrid();
  } catch (e) { toast('失败：' + e.message); }
};
window.downloadFile = (fileId) => {
  const a = document.createElement('a');
  a.href = '/api/files/' + fileId + '/download?userToken=' + encodeURIComponent(orgToken);
  a.download = (fileMap[fileId] && fileMap[fileId].name) || 'file';
  document.body.appendChild(a); a.click(); a.remove();
};
window.previewFile = (fileId) => {
  const m = fileMap[fileId];
  // 有生效分享时直接打开专业文档查看器（可正确渲染 PDF/图片/源文件预览）；
  // 孤儿文件（无分享）才回退到原始预览端点。
  if (m && m.shareId) { window.open('/viewer.html?share=' + m.shareId, '_blank'); return; }
  window.open('/api/files/' + fileId + '/preview?userToken=' + encodeURIComponent(orgToken), '_blank');
};
window.shareFromFile = async (fileId) => {
  try {
    const r = await fetch('/api/files/' + fileId + '/share?userToken=' + encodeURIComponent(orgToken), { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || ('创建失败 HTTP ' + r.status));
    showShareResult(d);
  } catch (e) { toast('失败：' + e.message); }
};
function showShareResult(d) {
  const body = document.getElementById('shareResultBody');
  const tip = d.reused ? '该文件已有生效分享，已直接复用其链接（未重复创建）：' : '已从该文件创建分享：';
  body.innerHTML = `<p class="sub">${esc(tip)}</p>
    <div class="share-link-row"><input id="srLink" readonly value="${esc(d.link)}" /><button class="btn ghost sm" onclick="copyLink('${esc(d.link)}')">复制</button></div>
    ${d.qr ? `<img class="sr-qr" src="${d.qr}" alt="二维码" />` : ''}
    <p class="sub" style="margin-top:8px">分享 ID：${esc(d.shareId)}</p>`;
  document.getElementById('shareResultModal').classList.add('show');
}
window.batchDeleteFiles = async () => {
  const ids = Array.from(selectedFileIds);
  if (!ids.length) return;
  if (!(await confirmDialog('确定删除选中的 ' + ids.length + ' 个文件？仅未被生效分享引用的会被删除，被引用的会跳过。', { danger: true }))) return;
  try {
    const r = await fetch('/api/files/batch-delete?userToken=' + encodeURIComponent(orgToken), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || d.error || ('批量删除失败 HTTP ' + r.status));
    selectedFileIds.clear();
    let msg = '✅ 已删除 ' + (d.deleted || 0) + ' 个';
    if (d.failedCount) msg += '，' + d.failedCount + ' 个因被分享引用而跳过';
    toast(msg);
    // 乐观更新：仅移除后端实际删除的（d.ok 列表），被引用的保留，不回源
    const okIds = new Set((d.ok || []));
    lastFiles = lastFiles.filter(f => !okIds.has(f.fileId));
    renderFileGrid();
  } catch (e) { toast('失败：' + e.message); }
};
window.replaceFile = (fileId) => {
  const inp = document.getElementById('replaceFileInput');
  inp.value = '';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    if (detectKind(file) === 'download') {
      toast('不支持的文件格式，无法替换：仅支持 PDF、Word(.docx)、常见图片与设计源文件(PSD/AI/CDR 等)');
      inp.onchange = null; return;
    }
    if (!(await confirmDialog('确定用「' + file.name + '」替换该文件？分享链接保持不变，客户将看到新文件。'))) { inp.onchange = null; return; }
    toast('正在替换…');
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
  if (!(await confirmDialog('确定删除该文件？', { danger: true }))) return;
  try {
    const r = await fetch('/api/files/' + fileId + '?userToken=' + encodeURIComponent(orgToken), { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (d.error === 'file_in_use' && d.shares) {
        await alertDialog('该文件仍被以下分享引用，请先处理这些分享：\n' + d.shares.map(s => s.name).join('\n'));
      } else throw new Error(d.message || d.error || ('删除失败 HTTP ' + r.status));
    } else {
      toast('✅ 已删除');
      // 乐观更新：从本地缓存移除并重渲染，不回源
      lastFiles = lastFiles.filter(f => f.fileId !== fileId);
      selectedFileIds.delete(fileId);
      renderFileGrid();
    }
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

// ========== 创建分享（原 app.js 迁入，单页内无刷新） ==========
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
let selectedFile = null;

function requireLogin() {
  if (localStorage.getItem('userToken')) return true;
  if (window.openLoginModal) window.openLoginModal();
  return false;
}

const drop = $('#drop'), fileInput = $('#file');
if (drop) drop.addEventListener('click', () => { if (!requireLogin()) return; fileInput.click(); });
if (drop) drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hot'); });
if (drop) drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
if (drop) drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('hot'); if (!requireLogin()) return; if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
if (fileInput) fileInput.addEventListener('change', () => {
  if (!fileInput.files[0]) return;
  if (!requireLogin()) { fileInput.value = ''; return; }
  setFile(fileInput.files[0]);
});

function setFile(f) {
  // 不支持的格式：选择即拦截，不上传
  if (detectKind(f) === 'download') {
    toast('不支持的文件格式，仅支持 PDF、Word(.docx)、常见图片(PNG/JPG/GIF/WEBP/BMP) 与设计源文件(PSD/AI/CDR 等)');
    selectedFile = null;
    if (fileInput) fileInput.value = '';
    $('#fileinfo').style.display = 'none';
    return;
  }
  selectedFile = f;
  const ic = /\.pdf$/i.test(f.name) ? '📕' : /\.docx?$/i.test(f.name) ? '📘' : /^image\//.test(f.type) ? '🖼️' : '📄';
  $('#fiIc').textContent = ic; $('#fiNm').textContent = f.name;
  const isSource = /\.(psd|psb|ai|cdr|eps|indd|tif|tiff|svg|raw|cr2|nef|arw|webp)$/i.test(f.name);
  $('#fiSz').textContent = fmtSize(f.size) + (isSource ? ' · 上传后将生成在线预览' : '');
  $('#fileinfo').style.display = 'flex';
  const fp = $('#fileProgress'); if (fp) fp.style.display = 'none';
  const fpBar = $('#fpBar'); if (fpBar) fpBar.style.width = '0%';
  const fpPct = $('#fpPct'); if (fpPct) fpPct.textContent = '0%';
  const fpSize = $('#fpSize'); if (fpSize) fpSize.textContent = '0 MB / 0 MB';
  if (!$('#name').value) $('#name').value = f.name.replace(/\.[^.]+$/, '');
  applyRestrictionVisibility(detectKind(f));
}

function detectKind(f) {
  const ext = '.' + (f.name.split('.').pop().toLowerCase());
  const mime = f.type || '';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext) || mime.startsWith('image/')) return 'image';
  if (ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (/\.(psd|psb|ai|cdr|eps|indd|tif|tiff|svg|raw|cr2|nef|arw|webp)$/i.test(ext)) return 'source';
  return 'download';
}
function applyRestrictionVisibility(kind) {
  const isDoc = (kind === 'pdf' || kind === 'docx');
  const isImage = (kind === 'image');
  document.querySelectorAll('.rest-doc').forEach(e => e.classList.toggle('hidden', !isDoc));
  document.querySelectorAll('.rest-shot').forEach(e => e.classList.toggle('hidden', !(isDoc || isImage)));
}

// 默认分享参数：从本地缓存（设置页保存）应用到表单
function applySharePrefs() {
  try {
    const raw = localStorage.getItem('sharePrefs');
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.expire !== undefined) {
      const v = String(p.expire);
      const allowed = ['1','3','7','30','0','custom'];
      setExpire(allowed.includes(v) ? v : '7', p.expireCustom);
    }
    if (p.watermark !== undefined) { const w = $('#watermark'); if (w) w.value = p.watermark; }
    if (p.copy !== undefined) { const c = $('#rCopy'); if (c) c.checked = !!p.copy; }
    if (p.print !== undefined) { const pr = $('#rPrint'); if (pr) pr.checked = !!p.print; }
    if (p.download !== undefined) { const d = $('#rDownload'); if (d) d.checked = !!p.download; }
    if (p.accessCode !== undefined) { const cd = $('#code'); if (cd) cd.value = p.accessCode || ''; }
    if (p.authMode !== undefined) {
      const v = String(p.authMode || 'open');
      document.querySelectorAll('#authChips button').forEach(b => b.classList.toggle('active', b.dataset.val === v));
    }
    if (p.maxViewers !== undefined) { const mv = $('#maxViewers'); if (mv) mv.value = String(p.maxViewers || 0); }
    if (p.maxViews !== undefined) { const mx = $('#maxViews'); if (mx) mx.value = String(p.maxViews || 0); }
    if (p.duration !== undefined) { const du = $('#duration'); if (du) du.value = String(p.duration || 0); }
    if (p.screenshot !== undefined) { const ss = $('#rScreenshot'); if (ss) ss.checked = !!p.screenshot; }
    const pe = $('#previewEnabled'), pp = $('#previewPages'), pwp = $('#protectPassword');
    const hasPreview = !!(p.previewPages && parseInt(p.previewPages, 10) > 0);
    if (pe) pe.checked = hasPreview;
    if (pp) pp.value = String(hasPreview ? (p.previewPages || 2) : 2);
    if (pwp) pwp.value = p.protectPassword || '';
    if (pe) pe.dispatchEvent(new Event('change'));
  } catch (e) {}
}
async function loadAndApplyPrefs() {
  const tk = localStorage.getItem('userToken');
  if (!tk) return;
  try {
    const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(tk), { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (d.prefs && typeof d.prefs === 'object') {
      try { localStorage.setItem('sharePrefs', JSON.stringify(d.prefs)); } catch (e) {}
    }
  } catch (e) {}
  applySharePrefs();
}
window.applySharePrefs = applySharePrefs;

const fiClear = document.getElementById('fiClear');
if (fiClear) fiClear.addEventListener('click', (e) => { e.preventDefault(); selectedFile = null; if (fileInput) fileInput.value = ''; $('#fileinfo').style.display = 'none'; });

async function uploadAndShare() {
  if (!selectedFile) return toast('请先选择文件');
  if (!requireLogin()) return;
  if (!checkStore()) { toast('您尚未归属任何门店，无法创建分享，请联系管理员分配门店'); return; }
  const btn = $('#shareBtn');
  const fp = $('#fileProgress'), fpBar = $('#fpBar'), fpPct = $('#fpPct'), fpSize = $('#fpSize');
  btn.disabled = true; btn.textContent = '上传中…';
  if (fp) fp.style.display = 'block';
  if (fpBar) fpBar.style.width = '0%';
  if (fpPct) fpPct.textContent = '0%';
  if (fpSize) fpSize.textContent = '0 MB / ' + fmtSize(selectedFile.size);
  const userToken = localStorage.getItem('userToken');
  try {
    const upRes = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = '/api/upload?userToken=' + encodeURIComponent(userToken || '') + '&name=' + encodeURIComponent(selectedFile.name) + '&mime=' + encodeURIComponent(selectedFile.type || 'application/octet-stream');
      xhr.open('POST', url, true);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.min(100, Math.round((e.loaded / e.total) * 100));
          if (fpBar) fpBar.style.width = p + '%';
          if (fpPct) fpPct.textContent = p + '%';
          if (fpSize) fpSize.textContent = fmtSize(e.loaded) + ' / ' + fmtSize(e.total);
        } else {
          if (fpPct) fpPct.textContent = '…';
          if (fpSize) fpSize.textContent = '已上传 ' + fmtSize(e.loaded);
        }
      };
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error((body && body.message) || body.error || ('上传失败（HTTP ' + xhr.status + '）')));
      };
      xhr.onerror = () => reject(new Error('网络错误，上传失败'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.send(selectedFile);
    });

    const activeChip = document.querySelector('#expireChips button.active, #expireCustomBtn.active');
    const val = activeChip ? activeChip.dataset.val : '7';
    let expiresAt = null;
    if (val === '0') {
      expiresAt = null;
    } else if (val === 'custom') {
      const ec = $('#expireCustom');
      const dt = ec && ec.value ? new Date(ec.value).getTime() : 0;
      expiresAt = dt > Date.now() ? dt : null;
    } else {
      const days = parseInt(val, 10) || 0;
      if (days > 0) expiresAt = Date.now() + days * 86400000;
    }
    const previewEnabled = $('#previewEnabled') && $('#previewEnabled').checked;
    const previewPages = previewEnabled ? (parseInt($('#previewPages').value, 10) || 2) : 0;
    const protectPassword = previewEnabled ? ($('#protectPassword').value.trim() || null) : null;
    const extra = { previewPages };
    if (protectPassword) extra.protectPassword = protectPassword;
    const settings = {
      name: $('#name').value || selectedFile.name,
      accessCode: $('#code').value.trim() || null,
      maxViewers: parseInt($('#maxViewers').value, 10) || 0,
      maxViews: parseInt($('#maxViews').value, 10) || 0,
      durationSec: (parseInt($('#duration').value, 10) || 0) * 60,
      authMode: (document.querySelector('#authChips button.active') || { dataset: { val: 'open' } }).dataset.val,
      watermark: $('#watermark').value.trim(),
      disableCopy: $('#rCopy').checked, disablePrint: $('#rPrint').checked,
      disableDownload: $('#rDownload').checked, disableScreenshot: $('#rScreenshot').checked,
      extra,
      expiresAt
    };
    const sh = await fetch('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: upRes.fileId, settings, userToken: userToken || null })
    });
    const shRes = await sh.json().catch(() => ({}));
    if (!sh.ok) throw new Error((shRes && shRes.message) || shRes.error || ('创建分享失败（HTTP ' + sh.status + '）'));

    $('#qrImg').src = shRes.qr;
    $('#linkInput').value = location.origin + '/viewer.html?share=' + shRes.shareId;
    $('#openViewer').href = $('#linkInput').value;
    // 单页内：成功后可直接切到「我的分享」查看，不跳转独立页面
    $('#openAdmin').style.display = '';
    $('#openAdmin').onclick = () => { history.replaceState(null, '', '#mine'); switchTab('mine'); };
    $('#result').classList.add('show');

    // 成功后给出明确反馈：若设置了预览密码，提醒访客需输入后续密码
    if (extra.previewPages && extra.protectPassword) {
      toast('已创建分享，访客预览超过 ' + extra.previewPages + ' 页后需输入密码查看');
    } else {
      toast('分享创建成功');
    }

    // 乐观更新：把新分享插入本地缓存，切到「我的分享」即时可见（无需重拉整表）
    const newShare = {
      shareId: shRes.shareId, name: settings.name, kind: detectKind(selectedFile),
      opens: 0, viewers: 0, expiresAt: settings.expiresAt, maxViewers: settings.maxViewers,
      status: 'active', authMode: settings.authMode, accessCode: settings.accessCode || '',
      restrictions: { copy: settings.disableCopy, print: settings.disablePrint, download: settings.disableDownload, screenshot: settings.disableScreenshot },
      extra: extra,
      link: '/viewer.html?share=' + shRes.shareId, fileId: upRes.fileId
    };
    mineShares.unshift(newShare);
    panelLoaded.mine = true;
    renderMineGrid();

    // 重置创建表单
    selectedFile = null; if (fileInput) fileInput.value = '';
    $('#fileinfo').style.display = 'none';
    if (fp) fp.style.display = 'none';
  } catch (e) {
    toast('失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '立即分享';
    if (fp) fp.style.display = 'none';
    if (fpBar) fpBar.style.width = '0%';
    if (fpPct) fpPct.textContent = '0%';
  }
}
const shareBtn = document.getElementById('shareBtn');
if (shareBtn) shareBtn.addEventListener('click', uploadAndShare);

// 有效期：预设胶囊 + 始终可点的日期
function setExpire(val, dateStr) {
  const chips = document.querySelectorAll('#expireChips button, #expireCustomBtn');
  chips.forEach(b => b.classList.toggle('active', b.dataset.val === val));
  const ec = document.getElementById('expireCustom');
  const hint = document.getElementById('expireHint');
  const row = document.getElementById('expireCustomRow');
  if (val === '0') {
    // 永久：隐藏日期行，卡片不撑大
    if (ec) { ec.value = ''; ec.disabled = true; }
    if (row) row.style.display = 'none';
  } else if (val === 'custom') {
    if (row) row.style.display = 'flex';
    if (ec) {
      ec.disabled = false;
      if (dateStr) ec.value = dateStr;
      else if (!ec.value) {
        const d = new Date(Date.now() + 7 * 86400000);
        ec.value = d.toISOString().slice(0, 16);
      }
    }
    if (hint && ec) {
      const dt = ec.value ? new Date(ec.value).getTime() : 0;
      hint.textContent = dt > Date.now() ? ('将于 ' + new Date(ec.value).toLocaleString() + ' 到期') : '请选择自定义到期时间';
      hint.classList.toggle('empty', !(dt > Date.now()));
    }
  } else {
    if (row) row.style.display = 'flex';
    const days = parseInt(val, 10);
    const d = new Date(Date.now() + days * 86400000);
    if (ec) { ec.value = d.toISOString().slice(0, 16); ec.disabled = false; }
    if (hint) { hint.textContent = '将于 ' + d.toLocaleString() + ' 到期'; hint.classList.remove('empty'); }
  }
}

(function initExpire() {
  const chips = document.querySelectorAll('#expireChips button, #expireCustomBtn');
  chips.forEach(b => b.addEventListener('click', () => setExpire(b.dataset.val)));
  const ec = document.getElementById('expireCustom');
  if (ec) ec.addEventListener('change', () => {
    const active = document.querySelector('#expireChips button.active, #expireCustomBtn.active');
    const val = active ? active.dataset.val : 'custom';
    // 手动改了日期，视为自定义
    setExpire('custom', ec.value);
  });
  setExpire('7');
})();

// 验证方式：单选胶囊
(function initAuth() {
  const chips = document.querySelectorAll('#authChips button');
  chips.forEach(b => b.addEventListener('click', () => {
    chips.forEach(x => x.classList.toggle('active', x === b));
  }));
})();
const previewEnabled = document.getElementById('previewEnabled');
if (previewEnabled) previewEnabled.addEventListener('change', () => {
  const pp = document.getElementById('previewPages');
  const pwp = document.getElementById('protectPassword');
  if (pp) pp.disabled = !previewEnabled.checked;
  if (pwp) pwp.disabled = !previewEnabled.checked;
});
const copyLinkBtn = document.getElementById('copyLink');
if (copyLinkBtn) copyLinkBtn.addEventListener('click', () => { navigator.clipboard.writeText($('#linkInput').value); toast('链接已复制'); });
function closeResult() { $('#result').classList.remove('show'); }
const closeResultBtn = document.getElementById('closeResult');
if (closeResultBtn) closeResultBtn.addEventListener('click', closeResult);
const resultModal = document.getElementById('result');
if (resultModal) resultModal.addEventListener('click', (e) => { if (e.target === resultModal) closeResult(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && resultModal && resultModal.classList.contains('show')) closeResult(); });

// ========== 设置（原 settings.js 迁入，单页内无刷新） ==========
let settingsBound = false;
function initSettings() {
  const tk = localStorage.getItem('userToken');
  if (!tk) {
    const need = $('#setNeedLogin'); if (need) need.style.display = 'block';
    const content = $('#setContent'); if (content) content.style.display = 'none';
    const foot = document.querySelector('.set-foot'); if (foot) foot.style.display = 'none';
    return;
  }
  const need = $('#setNeedLogin'); if (need) need.style.display = 'none';
  const content = $('#setContent'); if (content) content.style.display = '';
  const foot = document.querySelector('.set-foot'); if (foot) foot.style.display = '';
  if (!settingsBound) {
    settingsBound = true;
    bindToggle('setOldToggle', 'setOldPw');
    bindToggle('setNewToggle', 'setNewPw');
    const sb = $('#setSave'); if (sb) sb.onclick = saveSettings;
    const cc = $('#setClearCache');
    if (cc) cc.onclick = () => {
      try { localStorage.removeItem('sharePrefs'); ['sb-token', 'supabase.auth.token'].forEach(k => localStorage.removeItem(k)); sessionStorage.clear(); } catch (e) {}
      toast('已清除本地缓存'); loadSettings();
    };
    const lo = $('#setLogout'); if (lo) lo.onclick = logout;
  }
  loadSettings();
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
const toNum = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
async function loadSettings() {
  const tk = localStorage.getItem('userToken');
  if (!tk) return;
  try {
    const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(tk), { cache: 'no-store' });
    if (!r.ok) throw new Error('not ok');
    const d = await r.json();
    $('#setEmail').value = d.email || '';
    $('#setRole').value = d.isSuper ? '超级管理员' : (d.role === 'admin' ? '店长' : '成员');
    $('#setRealName').value = d.realName || '';
    const orgSec = $('#setOrgSec');
    if (orgSec) { $('#setOrg').value = d.orgName || '—'; orgSec.style.display = d.orgName ? 'block' : 'none'; }
    const DEFAULT_PREFS = { expire: '7', watermark: '', copy: true, print: true, download: true, accessCode: '', authMode: 'open', maxViewers: 0, maxViews: 0, duration: 0, screenshot: false, previewPages: 0, protectPassword: '' };
    const p = Object.assign({}, DEFAULT_PREFS, d.prefs || {});
    $('#setExpire').value = String(p.expire);
    $('#setAuthMode').value = p.authMode || 'open';
    $('#setCode').value = p.accessCode || '';
    $('#setWatermark').value = p.watermark || '';
    $('#setMaxViewers').value = toNum(p.maxViewers);
    $('#setMaxViews').value = toNum(p.maxViews);
    $('#setDuration').value = toNum(p.duration);
    $('#setPreviewPages').value = toNum(p.previewPages);
    $('#setCopy').checked = !!p.copy;
    $('#setPrint').checked = !!p.print;
    $('#setDownload').checked = !!p.download;
    $('#setScreenshot').checked = !!p.screenshot;
    $('#setOldPw').value = ''; $('#setNewPw').value = ''; $('#setNewPw2').value = '';
    if (typeof window.afterLogin === 'function') window.afterLogin(d.realName || d.email);
  } catch (e) {
    const msg = $('#setMsg'); if (msg) msg.textContent = '读取资料失败，请刷新重试';
  }
}
async function saveSettings() {
  const tk = localStorage.getItem('userToken');
  const msg = $('#setMsg');
  const realName = $('#setRealName').value.trim();
  if (!realName) { msg.textContent = '真实姓名不能为空'; return; }
  const oldPw = $('#setOldPw').value, newPw = $('#setNewPw').value, newPw2 = $('#setNewPw2').value;
  if ((oldPw || newPw || newPw2) && (!oldPw || !newPw || !newPw2)) { msg.textContent = '修改密码需填原密码、新密码、确认新密码三项'; return; }
  if (newPw && newPw !== newPw2) { msg.textContent = '两次输入的新密码不一致'; return; }
  const prefs = {
    expire: $('#setExpire').value, authMode: $('#setAuthMode').value, accessCode: $('#setCode').value.trim(),
    watermark: $('#setWatermark').value.trim(), maxViewers: toNum($('#setMaxViewers').value), maxViews: toNum($('#setMaxViews').value),
    duration: toNum($('#setDuration').value), previewPages: toNum($('#setPreviewPages').value), protectPassword: $('#setProtectPassword').value.trim(),
    copy: $('#setCopy').checked, print: $('#setPrint').checked, download: $('#setDownload').checked, screenshot: $('#setScreenshot').checked
  };
  const btn = $('#setSave'); btn.disabled = true;
  try {
    const pr = await fetch('/api/auth/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userToken: tk, realName, prefs }) });
    const pd = await pr.json().catch(() => ({}));
    if (!pr.ok) { msg.textContent = pd.message || pd.error || '保存失败'; btn.disabled = false; return; }
    if (newPw) {
      const cp = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userToken: tk, oldPassword: oldPw, newPassword: newPw }) });
      const cd = await cp.json().catch(() => ({}));
      if (!cp.ok) { msg.textContent = cd.message || cd.error || '修改密码失败'; btn.disabled = false; return; }
    }
    try { localStorage.setItem('sharePrefs', JSON.stringify(prefs)); } catch (e) {}
    if (typeof window.applySharePrefs === 'function') window.applySharePrefs();
    msg.style.color = '#16a34a';
    msg.textContent = '已保存' + (newPw ? '（密码已修改，其它设备已退出）' : '');
    setTimeout(() => { msg.style.color = '#e5484d'; msg.textContent = ''; }, 2200);
    loadSettings();
  } catch (e) { msg.textContent = '网络错误，请重试'; }
  finally { btn.disabled = false; }
}

