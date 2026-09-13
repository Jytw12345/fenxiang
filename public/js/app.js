'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';

let selectedFile = null;

// 登录态展示：向后端校验 token，避免本地残留过期 token 导致误判
const userArea = document.getElementById('userArea');
function logout() { localStorage.removeItem('userToken'); localStorage.removeItem('userEmail'); localStorage.removeItem('savedLogin'); location.reload(); }
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
  const token = localStorage.getItem('userToken');
  // 未登录默认隐藏受保护导航项，只显示简单的分享界面
  if (typeof window.applyNavVisibility === 'function') window.applyNavVisibility({ loggedIn: false });
  // 先显示登录入口，避免异步校验期间右上角空白
  showLogin();
  if (!token) return;
  try {
    const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(token), { cache: 'no-store' });
    if (!r.ok) throw new Error('session_invalid');
    const d = await r.json();
    if (d.email) localStorage.setItem('userEmail', d.email);
    showUser(d.email);
    if (typeof window.applyNavVisibility === 'function') window.applyNavVisibility({ loggedIn: true, isSuper: !!d.isSuper, email: d.email });
    loadAndApplyPrefs();
  } catch (e) {
    // 令牌无效/过期：清除并回到登录入口，但不重载页面，
    // 避免与 env.js 的 Supabase 会话同步形成刷新死循环。
    localStorage.removeItem('userToken');
    localStorage.removeItem('userEmail');
    showLogin();
    if (typeof window.applyNavVisibility === 'function') window.applyNavVisibility({ loggedIn: false });
  }
}
initUserArea();

const drop = $('#drop'), fileInput = $('#file');
function isLoggedIn() { return !!localStorage.getItem('userToken'); }
function requireLogin() {
  if (isLoggedIn()) return true;
  if (window.openLoginModal) window.openLoginModal();
  return false;
}
drop.addEventListener('click', () => { if (!requireLogin()) return; fileInput.click(); });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hot'); });
drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('hot'); if (!requireLogin()) return; if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => {
  if (!fileInput.files[0]) return;
  if (!requireLogin()) { fileInput.value = ''; return; }
  setFile(fileInput.files[0]);
});

function setFile(f) {
  selectedFile = f;
  const ic = /\.pdf$/i.test(f.name) ? '📕' : /\.docx?$/i.test(f.name) ? '📘' : /^image\//.test(f.type) ? '🖼️' : '📄';
  $('#fiIc').textContent = ic; $('#fiNm').textContent = f.name;
  const isSource = /\.(psd|psb|ai|cdr|eps|indd|tif|tiff|svg|raw|cr2|nef|arw|webp)$/i.test(f.name);
  $('#fiSz').textContent = fmtSize(f.size) + (isSource ? ' · 上传后将生成在线预览' : '');
  $('#fileinfo').style.display = 'flex';
  if (!$('#name').value) $('#name').value = f.name.replace(/\.[^.]+$/, '');
  // 按文件类型切换可用权限选项（文档/图片类型化）
  applyRestrictionVisibility(detectKind(f));
}

// 与后端 server/index.js 的 kind 判定保持一致
function detectKind(f) {
  const ext = '.' + (f.name.split('.').pop().toLowerCase());
  const mime = f.type || '';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext) || mime.startsWith('image/')) return 'image';
  if (ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (/\.(psd|psb|ai|cdr|eps|indd|tif|tiff|svg|raw|cr2|nef|arw|webp)$/i.test(ext)) return 'source';
  return 'download';
}
// 权限选项随类型显隐：复制/打印/预览页数仅文档；防截图仅文档+图片；下载所有类型
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
    if (p.expire !== undefined) { const e = $('#expire'); if (e) e.value = String(p.expire); }
    if (p.watermark !== undefined) { const w = $('#watermark'); if (w) w.value = p.watermark; }
    if (p.copy !== undefined) { const c = $('#rCopy'); if (c) c.checked = !!p.copy; }
    if (p.print !== undefined) { const pr = $('#rPrint'); if (pr) pr.checked = !!p.print; }
    if (p.download !== undefined) { const d = $('#rDownload'); if (d) d.checked = !!p.download; }
    if (p.accessCode !== undefined) { const cd = $('#code'); if (cd) cd.value = p.accessCode || ''; }
    if (p.authMode !== undefined) { const am = $('#authMode'); if (am) am.value = p.authMode || 'open'; }
    if (p.maxViewers !== undefined) { const mv = $('#maxViewers'); if (mv) mv.value = String(p.maxViewers || 0); }
    if (p.maxViews !== undefined) { const mx = $('#maxViews'); if (mx) mx.value = String(p.maxViews || 0); }
    if (p.duration !== undefined) { const du = $('#duration'); if (du) du.value = String(p.duration || 0); }
    if (p.screenshot !== undefined) { const ss = $('#rScreenshot'); if (ss) ss.checked = !!p.screenshot; }
    if (p.previewPages !== undefined) { const pp = $('#previewPages'); if (pp) pp.value = String(p.previewPages || 0); }
  } catch (e) { /* 忽略 */ }
}
// 登录/恢复会话后：拉取服务端保存的默认参数并应用（保证换设备也生效）
async function loadAndApplyPrefs() {
  const token = localStorage.getItem('userToken');
  if (!token) return;
  try {
    const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(token), { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (d.prefs && typeof d.prefs === 'object') {
      try { localStorage.setItem('sharePrefs', JSON.stringify(d.prefs)); } catch (e) {}
    }
  } catch (e) { /* 忽略 */ }
  applySharePrefs();
}
window.applySharePrefs = applySharePrefs;
$('#fiClear').addEventListener('click', (e) => { e.preventDefault(); selectedFile = null; fileInput.value = ''; $('#fileinfo').style.display = 'none'; });

async function uploadAndShare() {
  if (!selectedFile) return toast('请先选择文件');
  if (!requireLogin()) return;
  const btn = $('#shareBtn'); btn.disabled = true; btn.textContent = '正在上传并加密…';
  const userToken = localStorage.getItem('userToken');
  try {
    // 1) 上传原始字节（必须登录）
    const buf = await selectedFile.arrayBuffer();
    const up = await fetch('/api/upload?userToken=' + encodeURIComponent(userToken || '') + '&name=' + encodeURIComponent(selectedFile.name) + '&mime=' + encodeURIComponent(selectedFile.type || 'application/octet-stream'), {
      method: 'POST', body: buf
    });
    const upRes = await up.json().catch(() => ({}));
    if (!up.ok) throw new Error((upRes && upRes.message) || upRes.error || ('上传失败（HTTP ' + up.status + '）'));

    // 2) 创建分享
    const expVal = parseInt($('#expire').value, 10);
    const settings = {
      name: $('#name').value || selectedFile.name,
      accessCode: $('#code').value.trim() || null,
      maxViewers: parseInt($('#maxViewers').value, 10) || 0,
      maxViews: parseInt($('#maxViews').value, 10) || 0,
      durationSec: (parseInt($('#duration').value, 10) || 0) * 60,
      authMode: $('#authMode').value,
      watermark: $('#watermark').value.trim(),
      disableCopy: $('#rCopy').checked, disablePrint: $('#rPrint').checked,
      disableDownload: $('#rDownload').checked, disableScreenshot: $('#rScreenshot').checked,
      extra: { previewPages: parseInt($('#previewPages').value, 10) || 0 },
      expiresAt: expVal ? Date.now() + expVal * 86400000 : null
    };
    const sh = await fetch('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: upRes.fileId, settings, userToken: userToken || null })
    });
    const shRes = await sh.json().catch(() => ({}));
    if (!sh.ok) throw new Error((shRes && shRes.message) || shRes.error || ('创建分享失败（HTTP ' + sh.status + '）'));

    // 3) 展示结果
    $('#qrImg').src = shRes.qr;
    $('#linkInput').value = location.origin + '/viewer.html?share=' + shRes.shareId;
    $('#openViewer').href = $('#linkInput').value;
    // 后台界面必须登录后才能进入；匿名用户仅可创建/预览/复制分享链接，不再显示「进入管理后台」。
    // ownerToken 不再写入 localStorage，避免本机被他人拿到管理权。
    if (userToken) {
      $('#openAdmin').style.display = '';
      $('#openAdmin').href = '/admin.html';
      $('#openAdmin').onclick = null;
    } else {
      $('#openAdmin').style.display = 'none';
    }
    $('#result').classList.add('show');
  } catch (e) {
    toast('失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '立即分享';
  }
}
$('#shareBtn').addEventListener('click', uploadAndShare);
$('#copyLink').addEventListener('click', () => { navigator.clipboard.writeText($('#linkInput').value); toast('链接已复制'); });

// 成功弹窗：关闭按钮、点击遮罩、ESC 均可关闭
function closeResult() { $('#result').classList.remove('show'); }
$('#closeResult').addEventListener('click', closeResult);
$('#result').addEventListener('click', (e) => { if (e.target === $('#result')) closeResult(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#result').classList.contains('show')) closeResult(); });
