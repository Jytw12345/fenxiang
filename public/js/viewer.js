'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

const params = new URLSearchParams(location.search);
const shareId = params.get('share');
let viewerToken = localStorage.getItem('viewerToken');
if (!viewerToken) { viewerToken = crypto.randomUUID(); localStorage.setItem('viewerToken', viewerToken); }
let accessToken = null, restrictions = {}, watermarkText = '', kind = '', docName = '', expiresIn = 0, sessionStart = 0, hasPreview = false, previewPages = 0, needProtect = false, pdfDoc = null, totalPages = 0;
let downloadUrl = null;   // 受保护下载用的 blob URL（仅允许下载的文件类型会生成）

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
let restrictionsApplied = false;
function applyRestrictions() {
  if (restrictionsApplied) return;   // enterContent 可能被多次调用，避免监听器叠加
  restrictionsApplied = true;
  if (restrictions.copy) {
    document.body.style.userSelect = 'none';
    document.addEventListener('copy', (e) => { e.preventDefault(); toast('该分享已禁止复制'); });
    document.addEventListener('cut', (e) => { e.preventDefault(); toast('该分享已禁止剪切'); });
    document.addEventListener('selectstart', (e) => e.preventDefault());
  }
  if (restrictions.print) {
    // 打印：拦截并提示（beforeprint 下 body 会被替换，故用替换文案充当提示，键盘 Ctrl/Cmd+P 走 toast）
    window.addEventListener('beforeprint', () => { document.body.innerHTML = '<h2 style="padding:40px;text-align:center">该分享已禁止打印</h2>'; });
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); toast('该分享已禁止打印'); } });
  }
  // 拖拽保存图片同样是"另存为"的一条通道，跟随「禁下载」开关
  document.addEventListener('dragstart', (e) => { if (restrictions.download) e.preventDefault(); });
  // 右键：必须跟随「禁下载」开关。
  // 旧实现无条件 preventDefault 并固定提示"该分享已禁止下载"，
  // 结果分享者把「禁下载」取消勾选后，客户右键仍然被告知禁止下载（本次修的 bug）。
  document.addEventListener('contextmenu', (e) => {
    if (!window.showCtxMenu) return;
    window.showCtxMenu(e, viewerCtxItems());
  });
}
// 客户侧右键菜单：只列出当前分享真正允许的操作，被限制的项以置灰形式说明原因，
// 而不是笼统地把整个右键都吞掉。
function viewerCtxItems() {
  const items = [{ label: '刷新页面', onClick: () => location.reload() }];
  if (typeof document.fullscreenEnabled === 'boolean' && document.fullscreenEnabled) {
    items.push({
      label: document.fullscreenElement ? '退出全屏' : '全屏查看',
      onClick: () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); }
    });
  }
  items.push('-');
  if (restrictions.download) items.push({ label: '禁止下载', disabled: true });
  else items.push({ label: '下载文件', onClick: saveDoc });
  if (restrictions.copy) items.push({ label: '禁止复制', disabled: true });
  else items.push({ label: '复制页面链接', onClick: () => { navigator.clipboard.writeText(location.href); toast('已复制链接'); } });
  if (restrictions.print) items.push({ label: '禁止打印', disabled: true });
  else items.push({ label: '打印', onClick: () => window.print() });
  return items;
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

// 心跳：页面可见时每 15 秒上报一次，用于后端统计「阅读时长」（离开/最小化不计时）
let heartbeatTimer = null;
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'visible') report('heartbeat');
  }, 15000);
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

// ---------- 时长控制 ----------
function enforceDuration() {
  if (!expiresIn) return;
  const ms = expiresIn - (Date.now() - sessionStart);
  if (ms <= 0) return timeout();
  setTimeout(timeout, ms);
}
function timeout() {
  stopHeartbeat();
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
  previewPages = (m.extra && Number(m.extra.previewPages) > 0) ? Number(m.extra.previewPages) : 0;
  needProtect = !!(m.extra && m.extra.needProtect);
  $('#docName').textContent = docName;
  // 方案 B：平时不显示「禁止复制/打印/下载/截图」等限制标签（避免客户感觉被防着）；
  // 仅在客户真正触发对应操作时（applyRestrictions / 下载按钮）弹 toast 提示。
  // 此处只保留中性/正向信息：访问码、需授权、可在线预览。
  const hints = [];
  if (m.requiresCode) hints.push({ icon: '🔐', text: '需访问码' });
  if (m.authMode === 'approve') hints.push({ icon: '✋', text: '需授权' });
  $('#restBadge').innerHTML = hints.length
    ? hints.map(h => `<span class="vhint"><span class="vhi">${h.icon}</span><span>${h.text}</span></span>`).join('')
    : '<span class="vhint"><span class="vhi">👁</span><span>可在线预览</span></span>';
  return m;
}

// 通过鉴权后进入内容（open / wechat 确认共用）
async function enterContent(res) {
  accessToken = res.accessToken; expiresIn = res.expiresIn; sessionStart = Date.now();
  if (res.previewPages !== undefined) previewPages = Number(res.previewPages) || 0;
  if (res.needProtect !== undefined) needProtect = !!res.needProtect;
  if (res.watermark) buildWatermark(res.watermark); else buildWatermark('');
  if (restrictions.screenshot) startMovingWatermark();
  applyRestrictions();
  // 允许下载时，顶部显示统一下载入口（PDF / 图片 / Word / 源文件均适用）
  const dlTop = $('#dlTop');
  if (dlTop && !restrictions.download) { dlTop.style.display = 'inline-flex'; dlTop.onclick = saveDoc; }
  $('#gate').style.display = 'none';
  $('#content').style.display = 'block';
  await loadContent(res.kind);
  enforceDuration();
  startHeartbeat();
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

async function renderPdfPage(i) {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(i);
  const vp = page.getViewport({ scale: 1.4 });
  const canvas = document.createElement('canvas');
  canvas.dataset.page = i;
  canvas.width = vp.width; canvas.height = vp.height;
  $('#pages').appendChild(canvas);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  report('progress', 'p' + i + '/' + totalPages);
}
function renderUnlockBox(limit, total) {
  const box = document.createElement('div');
  box.id = 'unlockBox';
  box.style.cssText = 'text-align:center;padding:28px 20px;background:#f9fafc;border-top:1px dashed var(--line)';
  box.innerHTML = `<p class="sub" style="margin:0 0 12px">已预览前 ${limit} 页，剩余 ${total - limit} 页受密码保护</p>
    <div style="display:flex;gap:8px;justify-content:center;max-width:320px;margin:0 auto">
      <input type="password" id="unlockPw" placeholder="请输入后续密码" style="flex:1" />
      <button class="btn sm" id="unlockBtn">解锁</button>
    </div>
    <p id="unlockErr" class="sub" style="color:var(--danger);min-height:18px;margin-top:8px;margin-bottom:0"></p>`;
  $('#pages').appendChild(box);
  $('#unlockBtn').onclick = async () => {
    const pw = $('#unlockPw').value.trim();
    if (!pw) return;
    try {
      const r = await fetch('/api/share/' + shareId + '/unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, password: pw })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { $('#unlockErr').textContent = d.message || '密码错误'; return; }
      needProtect = false;
      box.remove();
      for (let i = limit + 1; i <= total; i++) await renderPdfPage(i);
    } catch (e) { $('#unlockErr').textContent = '网络错误，请重试'; }
  };
  $('#unlockPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#unlockBtn').click(); });
}

async function loadContent(k) {
  if (k === 'pdf') {
    const r = await fetch('/api/content/' + shareId + '?at=' + accessToken);
    if (!r.ok) { $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败'; showGate('<p class="sub">内容加载失败或被拒绝</p>'); return; }
    const buf = await r.arrayBuffer();
    if (!window.pdfjsLib) { $('#pages').innerHTML = '<p class="sub">PDF 组件加载失败（本地 PDF.js 缺失）</p>'; return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    totalPages = pdfDoc.numPages;
    const limit = previewPages && previewPages < totalPages ? previewPages : totalPages;
    for (let i = 1; i <= limit; i++) await renderPdfPage(i);
    // 预览页数限制：未渲染的后续页暂不展示；如需密码保护则显示解锁表单
    if (limit < totalPages) {
      if (needProtect) renderUnlockBox(limit, totalPages);
      else {
        const tip = document.createElement('div');
        tip.className = 'sub';
        tip.style.cssText = 'text-align:center;padding:24px;color:var(--danger);font-weight:600';
        tip.textContent = `分享者限制仅可预览前 ${limit} 页；后续 ${totalPages - limit} 页未设置查看密码，如需完整内容请联系分享者`;
        $('#pages').appendChild(tip);
      }
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
    downloadUrl = URL.createObjectURL(blob);
    $('#dlWrap').style.display = 'block';
    $('#dlWrap').innerHTML = '<p>这是设计源文件（PSD / AI / CDR 等），当前暂无在线预览图。</p><p class="sub">可能原因：①服务器未安装转换后端；②该文件上传于启用预览之前。重新上传即可生成预览。</p>';
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
  downloadUrl = URL.createObjectURL(blob);
  $('#dlWrap').style.display = 'block';
  $('#dlWrap').innerHTML = '<p>该文件类型以受保护方式分享，可点击右上角「下载」获取原文件。</p>';
}
// 唯一的下载出口：顶部按钮与右键菜单都走这里，避免两处各写一套判断而走偏。
// 预览类文件（PDF / 图片 / Word）进入时不会预取原文件，这里按需拉取，避免白耗流量。
async function saveDoc() {
  if (restrictions.download) { toast('该分享已禁止下载'); return; }
  if (!downloadUrl) {
    try {
      const r = await fetch('/api/content/' + shareId + '?at=' + accessToken + '&raw=1');
      if (!r.ok) throw new Error('http ' + r.status);
      const blob = await r.blob();
      downloadUrl = URL.createObjectURL(blob);
    } catch (e) { toast('下载准备失败，请稍后重试'); return; }
  }
  const a = document.createElement('a');
  a.href = downloadUrl; a.download = docName; a.click();
}

(async () => {
  if (!shareId) { $('#gateTitle').textContent = '缺少参数'; showGate('<p class="sub">无效的分享链接</p>'); return; }
  const meta = await loadMeta();
  if (!meta) return;
  $('#gateTitle').textContent = '安阅 · 安全预览';
  showGate('<p class="sub" style="text-align:center;margin-bottom:12px">' + docName + '</p><button class="btn" style="width:100%" id="openBtn">申请打开</button>');
  $('#openBtn').onclick = () => requestAccess();
})();
