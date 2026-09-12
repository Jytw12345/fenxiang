'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

const params = new URLSearchParams(location.search);
const shareId = params.get('share');
let viewerToken = localStorage.getItem('viewerToken');
if (!viewerToken) { viewerToken = crypto.randomUUID(); localStorage.setItem('viewerToken', viewerToken); }
let accessToken = null, restrictions = {}, watermarkText = '', kind = '', docName = '', expiresIn = 0, sessionStart = 0, hasPreview = false;

function shortId() { return viewerToken.slice(0, 8); }

// ---------- 水印 ----------
function buildWatermark(text) {
  const wm = $('#wm'); wm.innerHTML = '';
  const base = (text || '内部资料 严禁外传') + '  ' + shortId();
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('span');
    s.textContent = base;
    s.style.left = (i % 6) * 17 + '%';
    s.style.top = Math.floor(i / 6) * 18 + '%';
    wm.appendChild(s);
  }
}
function startMovingWatermark() {
  const wm = $('#wm'); let t = 0;
  setInterval(() => { t = (t + 1) % 40; wm.style.transform = `translate(${t}px, ${t}px)`; }, 120);
}

// ---------- 限制操作 ----------
function applyRestrictions() {
  if (restrictions.copy) {
    document.body.style.userSelect = 'none';
    document.addEventListener('copy', (e) => e.preventDefault());
    document.addEventListener('cut', (e) => e.preventDefault());
    document.addEventListener('selectstart', (e) => e.preventDefault());
  }
  if (restrictions.print) {
    window.addEventListener('beforeprint', (e) => { document.body.innerHTML = '<h2 style="padding:40px">打印已被禁止</h2>'; });
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') e.preventDefault(); });
  }
  // 禁止右键/拖拽保存（下载/截图防护的一部分）
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('dragstart', (e) => e.preventDefault());
}

// ---------- 进度 / 关闭上报 ----------
let lastPage = 0;
function report(event, progress) {
  if (!accessToken) return;
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId, viewerToken, accessToken, event, progress }) }).catch(() => {});
}
function trackPage() {
  const pages = document.querySelectorAll('#pages canvas');
  if (!pages.length) return;
  const mid = window.scrollY + window.innerHeight / 2;
  let cur = 1;
  pages.forEach((c, i) => { if (c.offsetTop <= mid) cur = i + 1; });
  if (cur !== lastPage) { lastPage = cur; report('progress', 'p' + cur + '/' + pages.length); }
}
window.addEventListener('scroll', trackPage, { passive: true });
window.addEventListener('beforeunload', () => report('close'));

// ---------- 时长控制 ----------
function enforceDuration() {
  if (!expiresIn) return;
  const ms = expiresIn - (Date.now() - sessionStart);
  if (ms <= 0) return timeout();
  setTimeout(timeout, ms);
}
function timeout() {
  report('timeout');
  $('#content').style.display = 'none';
  $('#gate').style.display = 'block';
  $('#gateIcon').textContent = '⏱️';
  $('#gateTitle').textContent = '已到阅读时长，文档自动关闭';
  $('#gateBody').innerHTML = '<p class="sub" style="text-align:center">如需继续阅读，请联系分享者延长时长。</p>';
}

// ---------- 访问流程 ----------
function showGate(html) { $('#gateBody').innerHTML = html; $('#gate').style.display = 'block'; }

async function loadMeta() {
  const r = await fetch('/api/share/' + shareId);
  const m = await r.json();
  if (!r.ok) { $('#gateTitle').textContent = '无法打开'; showGate('<p class="sub" style="text-align:center">' + (m.error || '链接无效') + '</p>'); return false; }
  if (m.status !== 'active') { $('#gateTitle').textContent = '文档已下架'; showGate('<p class="sub" style="text-align:center">该文档已被分享者销毁或下架。</p>'); return false; }
  docName = m.name; kind = m.kind; restrictions = m.restrictions; watermarkText = m.watermark; hasPreview = !!m.preview;
  $('#docName').textContent = docName;
  const tags = [];
  tags.push(m.requiresCode ? '<span class="tag on">需访问码</span>' : '');
  tags.push(m.authMode === 'approve' ? '<span class="tag on">需授权</span>' : '');
  if (m.kind === 'source') tags.push('<span class="tag">源文件</span>');
  if (hasPreview) tags.push('<span class="tag on">可在线预览</span>');
  if (restrictions.copy) tags.push('<span class="tag off">禁复制</span>');
  if (restrictions.print) tags.push('<span class="tag off">禁打印</span>');
  if (restrictions.download) tags.push('<span class="tag off">禁下载</span>');
  if (restrictions.screenshot) tags.push('<span class="tag off">防截图</span>');
  $('#restBadge').innerHTML = tags.join('');
  return m;
}

// 通过鉴权后进入内容（open / wechat 确认共用）
async function enterContent(res) {
  accessToken = res.accessToken; expiresIn = res.expiresIn; sessionStart = Date.now();
  if (res.watermark) buildWatermark(res.watermark); else buildWatermark('');
  if (restrictions.screenshot) startMovingWatermark();
  applyRestrictions();
  $('#gate').style.display = 'none';
  $('#content').style.display = 'block';
  await loadContent(res.kind);
  enforceDuration();
}

async function requestAccess(code) {
  const r = await fetch('/api/access', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId, viewerToken, code }) });
  const res = await r.json();
  if (res.needCode) {
    showGate('<label class="field">请输入访问码</label><input id="codeInput" placeholder="访问码"/><button class="btn" style="width:100%;margin-top:10px" id="codeOk">确认</button>');
    $('#codeOk').onclick = () => requestAccess($('#codeInput').value.trim());
    return;
  }
  if (res.needApproval) {
    showGate('<p class="sub" style="text-align:center">已向分享者发送访问申请，<br/>请等待对方授权后刷新本页。</p>');
    return;
  }
  if (res.needWechat) {
    showGate('<p class="sub" style="text-align:center;margin-bottom:10px">该文档需微信扫码验证</p>' +
      '<div id="wxBox" style="text-align:center">' +
      '<iframe id="wxFrame" style="width:240px;height:300px;border:0;margin:0 auto;display:none"></iframe>' +
      '<img id="wxQr" class="qr" style="margin:0 auto;width:180px;height:180px;display:none"/>' +
      '<p class="sub" id="wxHint">正在生成二维码…</p>' +
      '<button class="btn sm" id="wxSim" style="display:none">模拟扫码确认</button></div>');
    (async () => {
      try {
        const r = await fetch('/api/wechat/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'verify', share: shareId, viewerToken }) });
        const d = await r.json();
        if (!r.ok) { $('#wxHint').textContent = '微信验证启动失败'; return; }
        if (d.mode === 'real') { $('#wxFrame').src = d.qrUrl; $('#wxFrame').style.display = 'block'; $('#wxHint').style.display = 'none'; }
        else { $('#wxQr').src = d.qr; $('#wxQr').style.display = 'block'; $('#wxHint').style.display = 'none'; $('#wxSim').style.display = 'inline-block'; }
        let timer = setInterval(async () => {
          try {
            const c = await (await fetch('/api/wechat/check?state=' + d.state)).json();
            if (c.ok && c.verified) {
              clearInterval(timer);
              await enterContent({ accessToken: c.accessToken, kind, watermark: watermarkText, restrictions, expiresIn: c.expiresIn });
            }
          } catch (e) { /* 轮询容错 */ }
        }, 1500);
        $('#wxSim').onclick = async () => {
          const s = await fetch('/api/wechat/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: d.state }) });
          if (!s.ok) toast('确认失败');
        };
      } catch (e) { $('#wxHint').textContent = '微信验证启动失败'; }
    })();
    return;
  }
  if (res.ok) {
    await enterContent(res);
    return;
  }
  // 其它错误（人数/次数/过期/销毁）
  $('#gateTitle').textContent = '无法访问';
  showGate('<p class="sub" style="text-align:center">' + (res.message || res.error || '访问被拒绝') + '</p>');
}

async function loadImage(url) {
  const r = await fetch(url);
  if (!r.ok) { $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败'; showGate('<p class="sub">预览图加载失败</p>'); return; }
  const blob = await r.blob();
  const u = URL.createObjectURL(blob);
  const img = document.createElement('img'); img.src = u; img.draggable = false;
  $('#imgWrap').style.display = 'block'; $('#imgWrap').appendChild(img);
}

async function loadContent(k) {
  if (k === 'pdf') {
    const r = await fetch('/api/content/' + shareId + '?at=' + accessToken);
    if (!r.ok) { $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败'; showGate('<p class="sub">内容加载失败或被拒绝</p>'); return; }
    const buf = await r.arrayBuffer();
    if (!window.pdfjsLib) { $('#pages').innerHTML = '<p class="sub">PDF 组件加载失败（本地 PDF.js 缺失）</p>'; return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement('canvas');
      canvas.dataset.page = i;
      canvas.width = vp.width; canvas.height = vp.height;
      $('#pages').appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      report('progress', 'p' + i + '/' + pdf.numPages);
    }
    return;
  }

  if (k === 'image') {
    await loadImage('/api/content/' + shareId + '?at=' + accessToken);
    return;
  }

  // 源文件（PSD/AI/CDR 等）：若已生成预览图则按图片渲染，否则降级为下载
  if (k === 'source') {
    if (hasPreview) {
      await loadImage('/api/preview/' + shareId + '?at=' + accessToken);
      return;
    }
    const r = await fetch('/api/content/' + shareId + '?at=' + accessToken);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    $('#dlWrap').style.display = 'block';
    $('#dlWrap').innerHTML = '<p>这是设计源文件（PSD / AI / CDR 等），当前服务器未启用在线预览转换。</p><p class="sub">请在本地设计软件中打开查看原始图层与矢量信息。</p><a class="btn" id="dlBtn">下载源文件</a>';
    $('#dlBtn').onclick = () => {
      if (restrictions.download) { toast('分享者已禁止下载'); return; }
      const a = document.createElement('a'); a.href = url; a.download = docName; a.click();
    };
    return;
  }

  if (k === 'docx') {
    const r = await fetch('/api/content/' + shareId + '?at=' + accessToken);
    const html = await r.text();
    $('#docxWrap').style.display = 'block';
    $('#docxBody').innerHTML = html;
    return;
  }

  // download 类型：受保护下载
  const r = await fetch('/api/content/' + shareId + '?at=' + accessToken);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  $('#dlWrap').style.display = 'block';
  $('#dlWrap').innerHTML = '<p>该文件类型以受保护方式分享。</p><a class="btn" id="dlBtn">下载文件</a>';
  $('#dlBtn').onclick = () => {
    if (restrictions.download) { toast('分享者已禁止下载'); return; }
    const a = document.createElement('a'); a.href = url; a.download = docName; a.click();
  };
}

(async () => {
  if (!shareId) { $('#gateTitle').textContent = '缺少参数'; showGate('<p class="sub">无效的分享链接</p>'); return; }
  const meta = await loadMeta();
  if (!meta) return;
  $('#gateTitle').textContent = '安全预览';
  showGate('<p class="sub" style="text-align:center;margin-bottom:12px">' + docName + '</p><button class="btn" style="width:100%" id="openBtn">申请打开</button>');
  $('#openBtn').onclick = () => requestAccess();
})();
