'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';

let selectedFile = null;

// 登录态展示：向后端校验 token，避免本地残留过期 token 导致误判
const userArea = document.getElementById('userArea');
function logout() { localStorage.removeItem('userToken'); localStorage.removeItem('userEmail'); location.reload(); }
function showLogin() { userArea.innerHTML = `<a href="/auth.html">登录 / 注册</a>`; }
function showUser(email) {
  const safe = String(email || '已登录').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  userArea.innerHTML = `👤 ${safe} · <a href="#" id="logoutLink">退出</a>`;
  document.getElementById('logoutLink').onclick = (e) => { e.preventDefault(); logout(); };
}
async function initUserArea() {
  const token = localStorage.getItem('userToken');
  // 先显示登录入口，避免异步校验期间右上角空白
  showLogin();
  if (!token) return;
  try {
    const r = await fetch('/api/auth/me?userToken=' + encodeURIComponent(token), { cache: 'no-store' });
    if (!r.ok) throw new Error('session_invalid');
    const d = await r.json();
    if (d.email) localStorage.setItem('userEmail', d.email);
    showUser(d.email);
  } catch (e) {
    logout();
  }
}
initUserArea();

const drop = $('#drop'), fileInput = $('#file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hot'); });
drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('hot'); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

function setFile(f) {
  selectedFile = f;
  const ic = /\.pdf$/i.test(f.name) ? '📕' : /\.docx?$/i.test(f.name) ? '📘' : /^image\//.test(f.type) ? '🖼️' : '📄';
  $('#fiIc').textContent = ic; $('#fiNm').textContent = f.name;
  const isSource = /\.(psd|psb|ai|cdr|eps|indd|tif|tiff|svg|raw|cr2|nef|arw|webp)$/i.test(f.name);
  $('#fiSz').textContent = fmtSize(f.size) + (isSource ? ' · 上传后将生成在线预览' : '');
  $('#fileinfo').style.display = 'flex';
  if (!$('#name').value) $('#name').value = f.name.replace(/\.[^.]+$/, '');
}
$('#fiClear').addEventListener('click', (e) => { e.preventDefault(); selectedFile = null; fileInput.value = ''; $('#fileinfo').style.display = 'none'; });

async function uploadAndShare() {
  if (!selectedFile) return toast('请先选择文件');
  const btn = $('#shareBtn'); btn.disabled = true; btn.textContent = '正在上传并加密…';
  try {
    // 1) 上传原始字节
    const buf = await selectedFile.arrayBuffer();
    const up = await fetch('/api/upload?name=' + encodeURIComponent(selectedFile.name) + '&mime=' + encodeURIComponent(selectedFile.type || 'application/octet-stream'), {
      method: 'POST', body: buf
    });
    const upRes = await up.json();
    if (!up.ok) throw new Error(upRes.error || '上传失败');

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
      expiresAt: expVal ? Date.now() + expVal * 86400000 : null
    };
    const sh = await fetch('/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: upRes.fileId, settings, userToken: userToken || null })
    });
    const shRes = await sh.json();
    if (!sh.ok) throw new Error(shRes.error || '创建失败');

    // 3) 展示结果
    $('#qrImg').src = shRes.qr;
    $('#linkInput').value = location.origin + '/viewer.html?share=' + shRes.shareId;
    $('#openViewer').href = $('#linkInput').value;
    const adminUrl = userToken ? '/admin.html' : '/admin.html?token=' + shRes.ownerToken;
    $('#openAdmin').href = adminUrl;
    localStorage.setItem('ownerToken', shRes.ownerToken);
    $('#result').classList.add('show');
  } catch (e) {
    toast('失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '立即分享';
  }
}
$('#shareBtn').addEventListener('click', uploadAndShare);
$('#copyLink').addEventListener('click', () => { navigator.clipboard.writeText($('#linkInput').value); toast('链接已复制'); });
