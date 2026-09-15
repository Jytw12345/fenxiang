'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

const params = new URLSearchParams(location.search);
const shareId = params.get('share');
let viewerToken = localStorage.getItem('viewerToken');
if (!viewerToken) { viewerToken = crypto.randomUUID(); localStorage.setItem('viewerToken', viewerToken); }

// 防嵌套：禁止被其它网站以 iframe 方式嵌入盗用。同源嵌入（如后台预览）不受影响。
// 浏览器 X-Frame-Options 已兜底拦截跨域嵌入；此处为防御纵深，跨域读取顶层来源会抛错 → 判定为非法嵌入。
(function antiEmbed() {
  try {
    if (window.self === window.top) return;            // 非嵌入，放行
    const topOrigin = new URL(window.top.location.href).origin;
    if (topOrigin === location.origin) return;          // 同源嵌入，放行
    document.documentElement.innerHTML = '<h2 style="padding:40px;text-align:center;color:#374151">该页面不允许被嵌入其它网站</h2>';
    throw new Error('embedded-blocked');
  } catch (e) {
    if (String(e && e.message).indexOf('embedded-blocked') >= 0)
      document.documentElement.innerHTML = '<h2 style="padding:40px;text-align:center;color:#374151">该页面不允许被嵌入其它网站</h2>';
  }
})();
let accessToken = null, restrictions = {}, wm = null, kind = '', docName = '', expiresIn = 0, sessionStart = 0, hasPreview = false, previewPages = 0, needProtect = false, pdfDoc = null, totalPages = 0;
let downloadUrl = null;   // 受保护下载用的 blob URL（仅允许下载的文件类型会生成）

function shortId() { return viewerToken.slice(0, 8); }

// ---------- 水印 ----------
// 后端下发 watermark 可能是 null / 旧版纯字符串 / 新模型对象 {mode,text,dl}
function parseWm(v) {
  if (!v) return null;
  if (typeof v === 'string') { if (!v.length) return null; return { mode: 'static', text: v, dl: false }; }
  if (v && v.mode && v.mode !== 'none') return { mode: v.mode, text: v.text || '', dl: !!v.dl };
  return null;
}
function wmBaseText() { return (wm && wm.text) ? wm.text : '内部资料 严禁外传'; }
function buildWatermark() {
  const wmEl = $('#wm'); wmEl.innerHTML = '';
  if (!wm) { wmEl.style.display = 'none'; return; }
  wmEl.style.display = '';
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('span');
    s.textContent = wmBaseText() + '  ' + shortId();
    s.style.left = (i % 6) * 17 + '%';
    s.style.top = Math.floor(i / 6) * 18 + '%';
    wmEl.appendChild(s);
  }
  if (wm.mode === 'dynamic') startDynamicWatermark();
}
// 动态水印：实时刷新访客ID + 时间，泄露后可溯源
function startDynamicWatermark() {
  const wmEl = $('#wm');
  setInterval(() => {
    const t = new Date().toTimeString().slice(0, 8);
    wmEl.querySelectorAll('span').forEach(s => { s.textContent = wmBaseText() + '  ' + shortId() + '  ' + t; });
  }, 1000);
}
// 动态水印 / 防截图：让水印层缓慢漂移，提升截图留存难度
function startMovingWatermark() {
  const wmEl = $('#wm'); let t = 0;
  setInterval(() => { t = (t + 1) % 40; wmEl.style.transform = `translate(${t}px, ${t}px)`; }, 120);
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
  docName = m.name; kind = m.kind; restrictions = m.restrictions; wm = parseWm(m.watermark); hasPreview = !!m.preview;
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
  buildWatermark();
  if ((wm && wm.mode === 'dynamic') || restrictions.screenshot) startMovingWatermark();
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
  if (res.error === 'link_bound') {
    showGate('<p class="sub" style="text-align:center">' + (res.message || '该链接已绑定首次打开的设备，无法转发给他人使用。') + '</p>');
    return;
  }
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
              await enterContent({ accessToken: c.accessToken, kind, watermark: wm, restrictions, expiresIn: c.expiresIn });
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
  enableImageZoom(img);
}

// 源文件预览：尝试从后端加载预览图。后端会在预览缺失时按需生成（首次访问可能稍慢），
// 若仍无预览（未装转换后端/不支持）则展示源文件下载提示，而非失败 gate。
async function loadSourcePreview() {
  const url = '/api/preview/' + shareId + '?at=' + accessToken;
  try {
    const r = await fetch(url);
    if (r.ok) { await loadImage(url); return; }
    // 仅 404（无可用预览图）才降级为源文件下载提示
    if (r.status === 404) {
      const cr = await fetch('/api/content/' + shareId + '?at=' + accessToken);
      if (cr.ok) {
        const blob = await cr.blob();
        downloadUrl = URL.createObjectURL(blob);
        $('#dlWrap').style.display = 'block';
        $('#dlWrap').innerHTML = '<p>这是设计源文件（PSD / AI / CDR 等），当前暂无在线预览图。</p><p class="sub">可能原因：①服务器未安装转换后端；②该文件上传于启用预览之前。重新上传即可生成预览。</p>';
        return;
      }
    }
    // 其他错误（403 会话失效 / 500 等）→ 失败提示，勿误导用户下载错误内容
    $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败';
    showGate('<p class="sub">预览加载失败，请刷新重试</p>');
  } catch (e) {
    $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败';
    showGate('<p class="sub">预览加载失败，请刷新重试</p>');
  }
}

async function pdfRenderPage(i, scale) {
  if (!pdfDoc) return;
  const pg = await pdfDoc.getPage(i);
  const s = scale || (pdfPages[i] && pdfPages[i].renderScale) || BASE_SCALE;
  const vp = pg.getViewport({ scale: s });
  const baseW = pg.getViewport({ scale: 1 }).width;   // 显示宽度与栅格倍率解耦，缩放不跳变
  let rec = pdfPages[i];
  if (!rec) { rec = { page: pg, canvas: document.createElement('canvas'), renderScale: 0, baseW }; rec.canvas.dataset.page = i; pdfPages[i] = rec; }
  rec.baseW = baseW;
  rec.canvas.width = vp.width; rec.canvas.height = vp.height;
  rec.canvas.style.width = baseW * pdfDisplay + 'px';
  rec.renderScale = s;
  if (!rec.canvas.parentNode) $('#pages').appendChild(rec.canvas);
  await pg.render({ canvasContext: rec.canvas.getContext('2d'), viewport: vp }).promise;
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
      for (let i = limit + 1; i <= total; i++) await pdfRenderPage(i);
    } catch (e) { $('#unlockErr').textContent = '网络错误，请重试'; }
  };
  $('#unlockPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#unlockBtn').click(); });
}

async function loadContent(k) {
  if (k === 'pdf') {
    pdfPages = []; pdfDisplay = 1;
    if (!window.pdfjsLib) { $('#pages').innerHTML = '<p class="sub">PDF 组件加载失败（本地 PDF.js 缺失）</p>'; return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    // 用 URL 流式加载：pdf.js 按页 Range 拉取，第一页先出，无需整本下载解析完才显示。
    // rangeChunkSize 调大至 1MB，减少单页 PDF 的请求次数。
    try {
      pdfDoc = await pdfjsLib.getDocument({ url: '/api/content/' + shareId + '?at=' + accessToken, rangeChunkSize: 1048576 }).promise;
    } catch (e) {
      $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败'; showGate('<p class="sub">PDF 加载失败或被拒绝</p>'); return;
    }
    totalPages = pdfDoc.numPages;
    const limit = previewPages && previewPages < totalPages ? previewPages : totalPages;
    for (let i = 1; i <= limit; i++) await pdfRenderPage(i);
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
    enablePdfZoom();
    return;
  }

  if (k === 'image') {
    // 直接给 <img> 设 URL：浏览器原生支持 Range 与缓存，超大图首屏更快、且可复用服务端字节区间
    const img = document.createElement('img');
    img.src = '/api/content/' + shareId + '?at=' + accessToken;
    img.draggable = false;
    img.onerror = () => { $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败'; showGate('<p class="sub">图片加载失败或被拒绝</p>'); };
    $('#imgWrap').style.display = 'block';
    $('#imgWrap').appendChild(img);
    enableImageZoom(img);
    return;
  }

  // 源文件（PSD/AI/CDR 等）：预览图在后台异步生成；此处统一尝试加载，未就绪时由后端按需触发，仍失败则降级为下载提示
  if (k === 'source') {
    await loadSourcePreview();
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

// ========== 缩放 / 平移 / 手势查看器 ==========
// ---- 可调参数：改这里即可微调体验（无需动下面的逻辑）----
const ZOOM_CFG = {
  min: 0.5,                 // 最小显示倍率（缩小下限）
  max: 4,                   // 最大显示倍率（放大上限）
  pdfBaseScale: 2,          // PDF 栅格化基准倍率（≈144DPI；越大越清晰但越占带宽）
  pdfCrispCap: 4,           // PDF 放大时按需重渲染的最高栅格倍率（决定放大后是否糊）
  pdfCrispMargin: 0.2,      // 清晰度判定余量（renderScale 达到 need-margin 即视为够清晰）
  pdfCrispDebounce: 220,    // 停止缩放后多久重渲染可见页（ms）
  stepIn: 1.25,             // 工具条「+」按钮倍率步进
  stepOut: 0.8,             // 工具条「−」按钮倍率步进
  wheelPdf: 1.1,            // PDF 滚轮（Ctrl/⌘+滚轮）每格倍率
  wheelImg: 1.12,           // 图片滚轮每格倍率
  dblClickToggle: 2,        // 图片双击在 1× 与该值之间切换
};
const BASE_SCALE = ZOOM_CFG.pdfBaseScale;
const MIN_DISP = ZOOM_CFG.min, MAX_DISP = ZOOM_CFG.max;
let pdfDisplay = 1;
let pdfPages = [];                    // {page, canvas, renderScale, baseW}
let crispTimer = null;
let zbar = null;
let zoomMode = null;                  // 'pdf' | 'image' | null
let imgScale = 1, imgX = 0, imgY = 0, imgContent = null, imgStage = null;
let pdfZoomReady = false, imgZoomReady = false;

function ensureZbar() {
  if (zbar) { zbar.style.display = 'flex'; return zbar; }
  zbar = document.createElement('div');
  zbar.className = 'zbar';
  zbar.innerHTML =
    '<button class="zbtn" data-act="out" title="缩小">−</button>' +
    '<span class="z-pct">100%</span>' +
    '<button class="zbtn" data-act="in" title="放大">+</button>' +
    '<span class="zsep"></span>' +
    '<button class="zbtn" data-act="reset" title="复位">复位</button>' +
    '<button class="zbtn" data-act="full" title="全屏">全屏</button>';
  zbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'in') zoomStep(ZOOM_CFG.stepIn);
    else if (a === 'out') zoomStep(ZOOM_CFG.stepOut);
    else if (a === 'reset') zoomReset();
    else if (a === 'full') zoomFull();
  });
  document.body.appendChild(zbar);
  return zbar;
}
function setZpct(v) { const p = zbar && zbar.querySelector('.z-pct'); if (p) p.textContent = Math.round(v * 100) + '%'; }
function zoomFull() {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen();
}
function zoomStep(f) { if (zoomMode === 'pdf') pdfSetDisplay(pdfDisplay * f); else if (zoomMode === 'image') imgSetScale(imgScale * f); }
function zoomReset() { if (zoomMode === 'pdf') pdfSetDisplay(1); else if (zoomMode === 'image') imgSetScale(1); }

// ---- PDF：改 canvas 显示宽度实现缩放，纵向原生滚动，宽页可原生横滑；放大到一定程度时重渲染可见页保持清晰 ----
function pdfApplyWidths() {
  pdfPages.forEach((r) => { if (r && r.canvas) r.canvas.style.width = r.baseW * pdfDisplay + 'px'; });
}
function pdfEnsureCrisp() {
  if (crispTimer) clearTimeout(crispTimer);
  crispTimer = setTimeout(async () => {
    const need = Math.min(ZOOM_CFG.pdfCrispCap, BASE_SCALE * pdfDisplay);
    const vh = window.innerHeight;
    for (const rec of pdfPages) {
      if (!rec || !rec.canvas || !rec.canvas.parentNode) continue;
      const r = rec.canvas.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) continue;          // 只重渲染可见页，省流量
      if (rec.renderScale >= need - ZOOM_CFG.pdfCrispMargin) continue;
      try { await pdfRenderPage(rec.canvas.dataset.page * 1, need); } catch (e) {}
    }
  }, ZOOM_CFG.pdfCrispDebounce);
}
function pdfSetDisplay(v) {
  pdfDisplay = Math.min(MAX_DISP, Math.max(MIN_DISP, v));
  $('#pages').classList.add('zoomed');
  pdfApplyWidths();
  setZpct(pdfDisplay);
  pdfEnsureCrisp();
}
function enablePdfZoom() {
  if (pdfZoomReady) return; pdfZoomReady = true;
  zoomMode = 'pdf';
  const stage = document.createElement('div'); stage.id = 'pdfStage';
  const pages = $('#pages');
  pages.parentNode.insertBefore(stage, pages);
  stage.appendChild(pages);
  pages.classList.add('zoomed');
  ensureZbar(); setZpct(1);
  // 桌面：Ctrl/⌘ + 滚轮缩放（不影响纵向滚动）
  stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    pdfSetDisplay(pdfDisplay * (e.deltaY < 0 ? ZOOM_CFG.wheelPdf : 1 / ZOOM_CFG.wheelPdf));
  }, { passive: false });
  // 触屏：双指捏合缩放
  let pinch = 0;
  stage.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = touchDist(e); }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinch) {
      e.preventDefault();
      const d = touchDist(e);
      pdfSetDisplay(pdfDisplay * (d / pinch));
      pinch = d;
    }
  }, { passive: false });
  stage.addEventListener('touchend', () => { pinch = 0; });
  window.addEventListener('resize', () => pdfEnsureCrisp());
}

// ---- 图片：transform 缩放 + 拖移 + 捏合，基于原图像素故放大不损画质 ----
function imgApply() { if (imgContent) { imgContent.style.transform = `translate(${imgX}px,${imgY}px) scale(${imgScale})`; setZpct(imgScale); } }
function imgSetScale(v) { imgScale = Math.min(MAX_DISP, Math.max(MIN_DISP, v)); imgClamp(); imgApply(); }
function imgClamp() {
  if (!imgStage || !imgContent) return;
  const sw = imgStage.clientWidth, sh = imgStage.clientHeight;
  const cw = imgContent.offsetWidth * imgScale, ch = imgContent.offsetHeight * imgScale;
  if (cw <= sw) imgX = (sw - cw) / 2; else imgX = Math.min(0, Math.max(sw - cw, imgX));
  if (ch <= sh) imgY = (sh - ch) / 2; else imgY = Math.min(0, Math.max(sh - ch, imgY));
}
function enableImageZoom(imgEl) {
  if (imgZoomReady) return; imgZoomReady = true;
  zoomMode = 'image';
  imgStage = document.createElement('div'); imgStage.id = 'imgStage';
  imgContent = document.createElement('div'); imgContent.className = 'zcontent';
  imgEl.parentNode.insertBefore(imgStage, imgEl);
  imgStage.appendChild(imgContent); imgContent.appendChild(imgEl);
  imgEl.style.maxWidth = 'none'; imgEl.style.width = 'auto'; imgEl.style.height = 'auto'; imgEl.draggable = false;
  ensureZbar(); setZpct(1);
  const fit = () => {
    const nw = imgEl.naturalWidth || imgEl.width, nh = imgEl.naturalHeight || imgEl.height;
    const f = Math.min((imgStage.clientWidth / (nw || 1)) || 1, (imgStage.clientHeight / (nh || 1)) || 1, 1);
    imgScale = f || 1;
    imgX = (imgStage.clientWidth - nw * imgScale) / 2;
    imgY = (imgStage.clientHeight - nh * imgScale) / 2;
    imgApply();
  };
  if (imgEl.complete) fit(); else imgEl.onload = fit;
  imgStage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = imgStage.getBoundingClientRect();
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    const ns = Math.min(MAX_DISP, Math.max(MIN_DISP, imgScale * (e.deltaY < 0 ? ZOOM_CFG.wheelImg : 1 / ZOOM_CFG.wheelImg)));
    imgX = ox - (ox - imgX) * (ns / imgScale);
    imgY = oy - (oy - imgY) * (ns / imgScale);
    imgScale = ns; imgClamp(); imgApply();
  }, { passive: false });
  let dragging = false, lx = 0, ly = 0;
  imgStage.addEventListener('mousedown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; imgStage.style.cursor = 'grabbing'; });
  window.addEventListener('mousemove', (e) => { if (!dragging) return; imgX += e.clientX - lx; imgY += e.clientY - ly; lx = e.clientX; ly = e.clientY; imgClamp(); imgApply(); });
  window.addEventListener('mouseup', () => { dragging = false; if (imgStage) imgStage.style.cursor = ''; });
  let last = null, pinchD = 0;
  imgStage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    else if (e.touches.length === 2) { pinchD = touchDist(e); last = null; }
  }, { passive: true });
  imgStage.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && last) {
      imgX += e.touches[0].clientX - last.x; imgY += e.touches[0].clientY - last.y;
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY }; imgClamp(); imgApply();
    } else if (e.touches.length === 2) {
      const d = touchDist(e), m = touchMid(e);
      const rect = imgStage.getBoundingClientRect();
      const ns = Math.min(MAX_DISP, Math.max(MIN_DISP, imgScale * (d / (pinchD || d))));
      const ox = m.x - rect.left, oy = m.y - rect.top;
      imgX = ox - (ox - imgX) * (ns / imgScale);
      imgY = oy - (oy - imgY) * (ns / imgScale);
      imgScale = ns; pinchD = d; imgClamp(); imgApply();
    }
  }, { passive: false });
  imgStage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchD = 0;
    if (e.touches.length === 1) last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  });
  imgStage.addEventListener('dblclick', () => imgSetScale(imgScale > 1.05 ? 1 : ZOOM_CFG.dblClickToggle));
}
function touchDist(e) { const a = e.touches[0], b = e.touches[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
function touchMid(e) { const a = e.touches[0], b = e.touches[1]; return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }

(async () => {
  if (!shareId) { $('#gateTitle').textContent = '缺少参数'; showGate('<p class="sub">无效的分享链接</p>'); return; }
  const meta = await loadMeta();
  if (!meta) return;
  $('#gateTitle').textContent = '安阅 · 安全预览';
  showGate('<p class="sub" style="text-align:center;margin-bottom:12px">' + docName + '</p><button class="btn" style="width:100%" id="openBtn">申请打开</button>');
  $('#openBtn').onclick = () => requestAccess();
})();
