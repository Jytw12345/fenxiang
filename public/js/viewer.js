'use strict';
const $ = (s) => document.querySelector(s);
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1800); };

const params = new URLSearchParams(location.search);
const shareId = params.get('share');
let viewerToken = localStorage.getItem('viewerToken');
// 兼容非安全上下文：crypto.randomUUID 只在安全上下文（HTTPS 真证书 / localhost）可用。
// 用 http://IP 或自签证书（浏览器显示"不安全"）访问时它是 undefined，直接调用会抛异常，
// 且该异常发生在脚本顶层 → 整个 viewer.js 中断，表现为闸门永远停在"正在准备…"、连 /api 请求都不发。
if (!viewerToken) {
  viewerToken = (window.crypto && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem('viewerToken', viewerToken);
}

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

// 复制到剪贴板：navigator.clipboard 同样只在安全上下文可用（http://IP、自签证书下为 undefined），
// 缺失时回退到 textarea + execCommand，保证"复制页面链接"在任何访问方式下都可用。
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      ok ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (e) { reject(e); }
  });
}

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
let wmTimer = null;
function startDynamicWatermark() {
  const wmEl = $('#wm');
  if (wmTimer) clearInterval(wmTimer);
  wmTimer = setInterval(() => {
    const t = new Date().toTimeString().slice(0, 8);
    wmEl.querySelectorAll('span').forEach(s => { s.textContent = wmBaseText() + '  ' + shortId() + '  ' + t; });
  }, 1000);
}
// 动态水印 / 防截图：让水印层缓慢漂移，提升截图留存难度
let moveTimer = null;
function startMovingWatermark() {
  const wmEl = $('#wm'); let t = 0;
  if (moveTimer) clearInterval(moveTimer);
  moveTimer = setInterval(() => { t = (t + 1) % 40; wmEl.style.transform = `translate(${t}px, ${t}px)`; }, 120);
}

// ---------- 限制操作 ----------
let restrictionsApplied = false;
let brandName = '';   // 白标品牌名（用于闸门标题 / 文档标题）

// 十六进制色阶调整：pct<0 变暗，pct>0 变亮，返回 #rrggbb
function shadeHex(hex, pct) {
  hex = (hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return hex;
  let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  if (pct < 0) { const f = 1 + pct; r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f); }
  else { r = Math.round(r + (255 - r) * pct); g = Math.round(g + (255 - g) * pct); b = Math.round(b + (255 - b) * pct); }
  const h = x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

// 白标（自定义品牌）渲染：应用主题色、显示品牌、页脚、文档标题
function applyBrand(brand) {
  if (!brand || typeof brand !== 'object') return;
  const root = document.documentElement;
  if (brand.color && /^#?[0-9a-fA-F]{6}$/.test(brand.color)) {
    const hex = brand.color[0] === '#' ? brand.color : '#' + brand.color;
    root.style.setProperty('--brand', hex);
    root.style.setProperty('--brand-d', shadeHex(hex, -0.16));
    root.style.setProperty('--brand-l', shadeHex(hex, 0.42));
    root.style.setProperty('--brand-xl', shadeHex(hex, 0.86));
  }
  const name = (brand.name || '').trim();
  const logo = (brand.logo || '').trim();
  const wb = document.getElementById('wbBrand');
  if (wb && (name || logo)) {
    wb.style.display = 'flex';
    const nm = document.getElementById('wbName');
    if (nm) nm.textContent = name || '安阅';
    const lg = document.getElementById('wbLogo');
    if (lg) {
      if (logo) {
        lg.src = logo; lg.style.display = 'block';
        lg.onerror = () => { lg.style.display = 'none'; };
      } else { lg.style.display = 'none'; }
    }
    brandName = name || '安阅';
  }
  // 页脚：仅当白标激活或明确请求隐藏时才介入，避免给旧分享凭空加页脚
  const foot = document.getElementById('wbFoot');
  if (foot) {
    const active = !!(name || logo || brand.hidePowered);
    if (active) {
      foot.style.display = 'block';
      foot.innerHTML = '由 <b>' + escapeHtml(brandName || '安阅') + '</b> 提供安全预览';
      if (brand.hidePowered) foot.style.display = 'none';
    }
  }
  if (brandName) document.title = brandName + ' · 文件预览';
}
function isField(el) { return el && el.tagName && /^(INPUT|TEXTAREA)$/.test(el.tagName); }
function applyRestrictions() {
  if (restrictionsApplied) return;   // enterContent 可能被多次调用，避免监听器叠加
  restrictionsApplied = true;
  if (restrictions.copy) {
    document.body.style.userSelect = 'none';
    // 注意：输入框（搜索框等）必须放行，否则客户连自己输入的关键词都无法修改
    document.addEventListener('copy', (e) => { if (isField(e.target)) return; e.preventDefault(); toast('该分享已禁止复制'); });
    document.addEventListener('cut', (e) => { if (isField(e.target)) return; e.preventDefault(); toast('该分享已禁止剪切'); });
    document.addEventListener('selectstart', (e) => { if (isField(e.target)) return; e.preventDefault(); });
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
  // 阅读导航类动作：与工具栏同源，方便桌面端不移动鼠标去顶部
  if (kind === 'pdf' && PDFV.doc) {
    items.push('-');
    items.push({ label: '顺时针旋转', onClick: () => pdfRotate(90) });
    items.push({ label: PDFV.view === 'single' ? '双页视图' : '单页视图', onClick: () => pdfSetView(PDFV.view === 'single' ? 'double' : 'single') });
    items.push({ label: '在文档中查找', onClick: openSearch });
  }
  items.push('-');
  if (restrictions.download) items.push({ label: '禁止下载', disabled: true });
  else items.push({ label: '下载文件', onClick: saveDoc });
  if (restrictions.copy) items.push({ label: '禁止复制', disabled: true });
  else items.push({ label: '复制页面链接', onClick: () => { copyText(location.href).then(() => toast('已复制链接')).catch(() => toast('复制失败，请手动复制地址栏')); } });
  if (restrictions.print) items.push({ label: '禁止打印', disabled: true });
  else items.push({ label: '打印', onClick: () => window.print() });
  return items;
}

// ---------- 进度 / 关闭上报 ----------
let lastPage = 0;
function report(event, progress) {
  if (!accessToken) return;
  fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    keepalive: true,   // beforeunload 关页时也要能把 close 事件送出去
    body: JSON.stringify({ shareId, viewerToken, accessToken, event, progress }) }).catch(() => {});
}
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
  closeSearch();
  closeThumbs();
  if (PDFV.present) presentExit();
  report('timeout');
  $('#content').style.display = 'none';
  $('#gate').style.display = 'block';
  $('#gateIcon').textContent = '⏱️';
  $('#gateTitle').textContent = '已到阅读时长，文档自动关闭';
  $('#gateBody').innerHTML = '<p class="sub" style="text-align:center">如需继续阅读，请联系分享者延长时长。</p>';
}

// ---------- 访问流程 ----------
function showGate(html) { $('#gateBody').innerHTML = html; $('#gate').style.display = 'block'; }

// 文档级加载提示：PDF 解析/下载、docx 拉取期间盖在内容区上，避免"一片空白像打不开"。
// 独立于 #pages（会被 innerHTML 清空），挂在 body 上；pointer-events:none 不挡操作。
let docLoadingEl = null;
function showDocLoading(text) {
  hideDocLoading();
  docLoadingEl = document.createElement('div');
  docLoadingEl.className = 'doc-loading';
  const sp = document.createElement('div'); sp.className = 'spin';
  const tx = document.createElement('div'); tx.className = 'ltxt'; tx.textContent = text || '正在加载…';
  docLoadingEl.appendChild(sp); docLoadingEl.appendChild(tx);
  document.body.appendChild(docLoadingEl);
}
function updateDocLoading(text) { if (docLoadingEl) { const t = docLoadingEl.querySelector('.ltxt'); if (t) t.textContent = text; } }
function hideDocLoading() { if (docLoadingEl) { docLoadingEl.remove(); docLoadingEl = null; } }

async function loadMeta() {
  let r, m;
  try {
    r = await fetch('/api/share/' + shareId);
    m = await r.json();
  } catch (e) {
    // 网络层失败 / 服务端返回非 JSON（500 报错页）都会走到这里。
    // 以前这里没有 try/catch，异常冒泡后闸门会永远停在"正在准备…"，无从判断。
    $('#gateIcon').textContent = '⚠️';
    $('#gateTitle').textContent = '无法打开';
    showGate('<p class="sub" style="text-align:center">分享信息加载失败，请稍后重试或联系分享者。</p>');
    return false;
  }
  if (!r.ok) { $('#gateTitle').textContent = '无法打开'; showGate('<p class="sub" style="text-align:center">' + (m.error || '链接无效') + '</p>'); return false; }
  if (m.status !== 'active') { $('#gateTitle').textContent = '文档已下架'; showGate('<p class="sub" style="text-align:center">该文档已被分享者销毁或下架。</p>'); return false; }
  docName = m.name; kind = m.kind; restrictions = m.restrictions; wm = parseWm(m.watermark); hasPreview = !!m.preview;
  previewPages = (m.extra && Number(m.extra.previewPages) > 0) ? Number(m.extra.previewPages) : 0;
  needProtect = !!(m.extra && m.extra.needProtect);
  if (m.extra && m.extra.brand) applyBrand(m.extra.brand);
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
  initToolbar(res.kind);
  await loadContent(res.kind);
  enforceDuration();
  startHeartbeat();
}

let accessInFlight = false;
async function requestAccess(code) {
  // 防抖：连点/回车重复提交会产生重复访问会话（虚增次数，甚至触发 max_views 锁死）
  if (accessInFlight) return;
  accessInFlight = true;
  try {
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
          let fails = 0;                 // 连续网络失败计数
          const t0 = Date.now();
          let timer = setInterval(async () => {
            try {
              const c = await (await fetch('/api/wechat/check?state=' + d.state)).json();
              fails = 0;
              if (c.ok && c.verified) {
                clearInterval(timer);
                await enterContent({ accessToken: c.accessToken, kind, watermark: wm, restrictions, expiresIn: c.expiresIn });
                return;
              }
            } catch (e) { fails++; }
            // 上限：连续失败 5 次或轮询超 10 分钟自动停止，避免无限后台请求
            if (fails >= 5 || Date.now() - t0 > 10 * 60 * 1000) {
              clearInterval(timer);
              const h = $('#wxHint');
              if (h) { h.style.display = ''; h.textContent = '验证状态获取超时，请刷新页面重试'; }
            }
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
  } finally { accessInFlight = false; }
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
    // 仅 404（无可用预览图）才降级为源文件下载提示。
    // 不再预载整个源文件：PSD/AI 动辄几百 MB，白耗流量；点下载时由 saveDoc 按需拉取
    if (r.status === 404) {
      $('#dlWrap').style.display = 'block';
      $('#dlWrap').innerHTML = '<p>这是设计源文件（PSD / AI / CDR 等），当前暂无在线预览图。</p><p class="sub">可能原因：①服务器未安装转换后端；②该文件上传于启用预览之前。重新上传即可生成预览。</p>';
      return;
    }
    // 其他错误（403 会话失效 / 500 等）→ 失败提示，勿误导用户下载错误内容
    $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败';
    showGate('<p class="sub">预览加载失败，请刷新重试</p>');
  } catch (e) {
    $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败';
    showGate('<p class="sub">预览加载失败，请刷新重试</p>');
  }
}

// ===================================================================
//  PDF 阅读器：工具栏 / 页码 / 缩略图 / 旋转 / 视图模式 / 文档内搜索 / 演示模式
//  设计底线：全部功能只做「定位与呈现」，不向 DOM 写入任何可选中文字。
//  因此搜索走 pdf.js 的 getTextContent 在内存里匹配 + 覆盖层色块高亮，
//  页面本身依旧是纯 canvas —— 客户能看到、能搜到，但依然选不中、复制不了。
// ===================================================================
const PDFV = {
  doc: null, total: 0, limit: 0, cur: 1,
  rot: 0,                 // 用户叠加旋转 0/90/180/270（与页面自带旋转相加）
  view: 'single',         // single | double | book
  display: 1,
  autoFit: true,          // 当前倍数是否来自「适宽」（窗口变化时自动重算；手动缩放后置 false）
  pages: [],              // [i] = {page, wrap, canvas, hl, renderScale, baseW, baseH, vp1}
  thumbs: [],             // [i] = {el, canvas, done}
  text: null,             // [i] = {str, items:[{start,end,it}]}
  hits: [], hitIdx: -1, kw: '',
  present: false,
  _est: null,             // 占位尺寸 {w,h}（来自第 1 页视口），铺占位页与缩略图用
  vis: new Set(),         // 当前处于可视区（含预渲染带）的页码，供缩放重渲染时按需处理
  rendered: new Set(),    // 当前仍持有像素内存的页码，用于兜底回收
};

// ---- 大文档惰性渲染 ----
// 先把全部页的容器按「占位尺寸」铺好（不解析 pdf 页对象、不分配像素内存：
// canvas 用 1×1 后备存储 + CSS 尺寸撑开），只对进入可视区（含 900px 预渲染带）的页做栅格化。
// 这样 700+ 页的文档也能秒开：首屏只渲染第 1 页，其余按滚动进度补渲。
async function pdfEstimateSize() {
  try {
    let pg = (PDFV.pages[1] && PDFV.pages[1].page) || await PDFV.doc.getPage(1);
    const rot = ((pg.rotate || 0) + PDFV.rot) % 360;
    const vp = pg.getViewport({ scale: 1, rotation: rot });
    return { w: vp.width, h: vp.height, page: pg };
  } catch (e) {
    return { w: 595, h: 842, page: null };   // A4 兜底
  }
}
// 预修正占位尺寸：混合页面尺寸的文档里，占位页全部按第 1 页尺寸铺开，真页渲染时才改
// 尺寸会造成轻微跳动。页一进入预渲染带就先取真实 viewport 更新占位（顺带同步缩略图比例），
// 等栅格化完成时占位早已是正确比例，肉眼无感。只解析进入预渲染带的页，不增加首屏成本。
async function pdfPreSize(i) {
  const rec = PDFV.pages[i];
  if (!rec || rec.vp1 || rec.renderScale) return;
  try {
    rec.page = rec.page || await PDFV.doc.getPage(i);
    const rot = ((rec.page.rotate || 0) + PDFV.rot) % 360;
    rec.vp1 = rec.page.getViewport({ scale: 1, rotation: rot });
    rec.baseW = rec.vp1.width; rec.baseH = rec.vp1.height;
    pdfSizePage(rec);
    // 缩略图占位比例同步修正（未渲染过的才需要；渲染过的 renderThumb 已用真实尺寸）
    const t = PDFV.thumbs[i];
    if (t && t.canvas && t.canvas.width === 1 && ZOOM_CFG && ZOOM_CFG.thumbScale) {
      t.canvas.style.aspectRatio = Math.ceil(rec.vp1.width * ZOOM_CFG.thumbScale) + ' / ' + Math.ceil(rec.vp1.height * ZOOM_CFG.thumbScale);
    }
  } catch (e) { /* 解析失败交给 queuePage 的渲染路径兜底 */ }
}
function pdfBuildPages(from, to) {
  const host = $('#pages');
  const est = PDFV._est || { w: 595, h: 842 };
  for (let i = from; i <= to; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'pg'; wrap.dataset.page = i;
    const canvas = document.createElement('canvas');
    const hl = document.createElement('div'); hl.className = 'pg-hl';
    wrap.appendChild(canvas); wrap.appendChild(hl);
    host.appendChild(wrap);
    const rec = { page: null, wrap, canvas, hl, renderScale: 0, baseW: est.w, baseH: est.h, vp1: null, _busy: false };
    canvas.width = 1; canvas.height = 1;
    pdfSizePage(rec);
    PDFV.pages[i] = rec;
  }
}
let pageObs = null;
// 渲染并发槽：pdf.js 各页 render 相互独立，并发 2 让首屏多页/快速滚动出图更快；
// 单页内存上限已在 pdfRenderPage 内按 GPU 上限钳制，并发不会放大峰值内存。
const RENDER_CONCURRENCY = 2;
let renderInFlight = 0;
const renderWaiters = [];
function acquireRenderSlot() {
  if (renderInFlight < RENDER_CONCURRENCY) { renderInFlight++; return Promise.resolve(); }
  return new Promise(r => renderWaiters.push(r));
}
function releaseRenderSlot() {
  const w = renderWaiters.shift();
  if (w) w(); else renderInFlight--;
}
function obsPages() {
  if (pageObs) pageObs.disconnect();
  if (!('IntersectionObserver' in window)) {          // 老浏览器兜底：顺序渲染（大文档会很慢，但至少能看）
    for (let i = 1; i <= PDFV.limit; i++) queuePage(i, pdfNeedScale());
    return;
  }
  pageObs = new IntersectionObserver((ents) => {
    ents.forEach((en) => {
      const i = +en.target.dataset.page;
      if (en.isIntersecting) {
        PDFV.vis.add(i);
        const rec = PDFV.pages[i];
        if (rec && !rec.renderScale) {
          pdfPreSize(i);         // 进入预渲染带先按真实页尺寸修正占位，消除混合尺寸文档的渲染跳动
          queuePage(i, pdfNeedScale());
        }
      } else {
        PDFV.vis.delete(i);
        releasePage(i);          // 离开预渲染带就释放像素内存，滚动到全篇也不会累积爆内存
      }
    });
  }, { rootMargin: '900px 0px' });                    // 提前 900px 预渲染，滚动时不易看到空白
  PDFV.pages.forEach((r) => { if (r) pageObs.observe(r.wrap); });
}
// 释放某页的像素内存，但保留占位尺寸（baseW/baseH 与 canvas 的 CSS 尺寸不动），
// 这样滚动位置不会跳动；再次滚回来时由观察器重新渲染。
function releasePage(i) {
  PDFV.rendered.delete(i);
  const rec = PDFV.pages[i];
  if (!rec || !rec.renderScale) return;
  rec.canvas.width = 1; rec.canvas.height = 1;
  rec.renderScale = 0;
  if (rec.wrap) rec.wrap.classList.remove('done');   // 像素已回收，重新露出骨架占位
  if (rec.hl) rec.hl.innerHTML = '';
}
// 兜底回收：万一观察器事件漏了一拍，滚动结束时把「离视口足够远」的页释放掉。
// 只遍历 rendered 集合（通常就几页），并对每一页读一次几何位置，成本可忽略；
// 判定带（1400px）远大于预渲染带（900px），所以不会把马上要用到的页回收掉、也不会闪烁。
function sweepReleased() {
  if (!PDFV.rendered.size) return;
  const vh = window.innerHeight, band = 1400;
  PDFV.rendered.forEach((i) => {
    const rec = PDFV.pages[i];
    if (!rec || !rec.wrap.parentNode) { releasePage(i); return; }
    const r = rec.wrap.getBoundingClientRect();
    if (r.bottom < -band || r.top > vh + band) releasePage(i);
  });
}
// 并发队列：同时最多栅格化 2 页（acquireRenderSlot 控制），避免 pdf.js 大量并发渲染互相干扰与瞬时内存峰值
function queuePage(i, scale) {
  const rec = PDFV.pages[i]; if (!rec) return Promise.resolve();
  if (rec._busy) return Promise.resolve();
  rec._busy = true;
  return acquireRenderSlot().then(() => pdfRenderPage(i, scale)).catch(() => {}).then(() => { rec._busy = false; releaseRenderSlot(); });
}

async function pdfMakePage(i) {
  const pg = await PDFV.doc.getPage(i);
  const wrap = document.createElement('div');
  wrap.className = 'pg'; wrap.dataset.page = i;
  const canvas = document.createElement('canvas');
  const hl = document.createElement('div'); hl.className = 'pg-hl';
  wrap.appendChild(canvas); wrap.appendChild(hl);
  PDFV.pages[i] = { page: pg, wrap, canvas, hl, renderScale: 0, baseW: 0, baseH: 0, vp1: null };
  $('#pages').appendChild(wrap);
  return PDFV.pages[i];
}

// ---- 移动端 GPU 画布安全上限 ----
// 手机 GPU 单张纹理有硬上限（iOS ≈ 16.7M 总像素、每边 4096~8192；Android 每边 8192~16384）。
// 超限的 canvas 只有上半部分能渲染、下半空白 —— 「高清大文件手机端只显示一半」的根因。
// 渲染任何一页前必须把栅格倍率钳制到安全范围；桌面端上限宽松得多。
const GPU_CAP = (function () {
  const coarse = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
  return coarse ? { side: 4096, area: 16.7e6 } : { side: 8192, area: 67e6 };
})();
function pdfCapScale(vp1, s) {
  if (!vp1 || !vp1.width || !vp1.height) return s;
  let cap = GPU_CAP.side / Math.max(vp1.width, vp1.height);              // 每边上限
  cap = Math.min(cap, Math.sqrt(GPU_CAP.area / (vp1.width * vp1.height))); // 总像素上限
  return Math.max(0.1, Math.min(s, cap));
}

// ---- 栅格倍率按「当前显示倍率」反推（大文件能打开的关键）----
// canvas 像素数 = 页面原始尺寸 × s，CSS 显示尺寸 = 页面原始尺寸 × display，
// 所以 s/display 才是有效像素密度：想看着清晰，只需 s ≈ display × DPR。
// 旧实现恒定按 BASE_SCALE(2) 栅格化，在超大页面上（工程图/长图海报适宽后 display 只有
// 0.1~0.2）等于白算上百倍像素 —— 单页 canvas 逼近 200MB，浏览器分配失败后 render 直接
// reject，表现就是「页面永远停在骨架」（大文件打不开、疑似内存不足的真因）。
function pdfDpr() { return Math.min(2, Math.max(1, window.devicePixelRatio || 1)); }
function pdfNeedScale() {
  const d = PDFV.display || 1;
  return Math.min(ZOOM_CFG.pdfCrispCap, Math.max(0.2, d * pdfDpr()));
}

// 按指定栅格倍率渲染某页；旋转通过 viewport 的 rotation 实现，canvas 尺寸随旋转互换，布局天然正确
// scale 缺省 = 当前显示需要的倍率；shrink 为失败降级重试的倍率折扣（0.5 = 砍半再试）
async function pdfRenderPage(i, scale, shrink) {
  if (!PDFV.doc) return;
  let rec = PDFV.pages[i];
  if (!rec) rec = await pdfMakePage(i);
  if (!rec.page) rec.page = await PDFV.doc.getPage(i);   // 惰性解析：占位页首次进入可视区时才取页对象
  const rot = ((rec.page.rotate || 0) + PDFV.rot) % 360;
  const vp1 = rec.page.getViewport({ scale: 1, rotation: rot });
  rec.vp1 = vp1;
  rec.baseW = vp1.width; rec.baseH = vp1.height;
  // 超大页钳制到 GPU 安全范围（否则手机上只渲染出上半页），再按显示需要取小者
  const s = pdfCapScale(vp1, (scale || pdfNeedScale()) * (shrink || 1));
  const vp = rec.page.getViewport({ scale: s, rotation: rot });
  rec.canvas.width = Math.ceil(vp.width);
  rec.canvas.height = Math.ceil(vp.height);
  rec.renderScale = s;
  pdfSizePage(rec);
  clearPageFailed(rec);                                 // 重试路径：先撤掉上一轮的失败提示
  let task = null;
  try {
    task = rec.page.render({ canvasContext: rec.canvas.getContext('2d'), viewport: vp });
    await task.promise;
  } catch (e) {
    try { if (task) task.cancel(); } catch (_) {}
    rec.renderScale = 0;
    rec.canvas.width = 1; rec.canvas.height = 1;
    // 失败多半是单页像素过大（canvas 分配不出显存/内存）→ 砍半再试一次；
    // 仍失败就给出明确提示，不让用户对着永久骨架猜「是不是还在加载」。
    if (!shrink && s > 0.25) return pdfRenderPage(i, scale, 0.5);
    markPageFailed(rec);
    return;
  }
  rec.wrap.classList.add('done');   // 渲染完成：隐藏占位骨架
  PDFV.rendered.add(i);
  // 翻页预渲染：当前页仍在可视区时预渲下一页（vis 判断防止连环预渲把整本渲完）
  if (PDFV.vis && PDFV.vis.has(i) && i + 1 <= PDFV.total && PDFV.pages[i + 1] && !PDFV.rendered.has(i + 1)) {
    queuePage(i + 1, s);
  }
  // 惰性渲染下，搜索命中的页往往是「渲染完成后」才拿到 vp1，这里补绘一次高亮，否则高亮会丢
  if (PDFV.hits.length) pdfRefreshHl();
}
// 像素过大渲不出来的页：撤骨架 + 出一行说明（否则用户只会看到无限加载的灰块）
function markPageFailed(rec) {
  if (!rec || !rec.wrap) return;
  rec.wrap.classList.add('done', 'failed');
  if (!rec.wrap.querySelector('.pg-msg')) {
    const m = document.createElement('div');
    m.className = 'pg-msg';
    m.innerHTML = '本页内容过大，浏览器无法渲染<br><span>可点击底部「下载」获取原文件</span>';
    rec.wrap.appendChild(m);
  }
  if (rec.hl) rec.hl.innerHTML = '';
}
function clearPageFailed(rec) {
  if (!rec || !rec.wrap) return;
  rec.wrap.classList.remove('failed');
  const m = rec.wrap.querySelector('.pg-msg');
  if (m) m.remove();
}
function pdfSizePage(rec) {
  rec.canvas.style.width = Math.round(rec.baseW * PDFV.display) + 'px';
  rec.canvas.style.height = Math.round(rec.baseH * PDFV.display) + 'px';
}
function pdfApplyWidths() {
  PDFV.pages.forEach((r) => { if (r && r.canvas && r.baseW) pdfSizePage(r); });
}

function renderUnlockBox(limit, total) {
  const box = document.createElement('div');
  box.id = 'unlockBox';
  box.style.cssText = 'text-align:center;padding:28px 20px;background:#f9fafc;border-top:1px dashed var(--line);width:100%';
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
      PDFV.text = null;   // 解锁后可搜索范围变了，清掉旧的全量文本索引，下次搜索时按全部页重建
      // 解锁后把剩余页补齐（同样走惰性渲染），并同步可搜索范围与缩略图
      PDFV.limit = PDFV.total;
      pdfBuildPages(limit + 1, total);
      buildThumbs();
      obsPages();
      pdfTrackPage();
    } catch (e) { $('#unlockErr').textContent = '网络错误，请重试'; }
  };
  $('#unlockPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#unlockBtn').click(); });
}

// PDF 渲染管线（pdf 分享与 PPT 转换件共用）：src={url} 流式 / {data:ArrayBuffer} 整体
async function loadPdfFromUrl(src, failMsg) {
    PDFV.pages = []; PDFV.rot = 0; PDFV.view = 'single'; PDFV.hits = []; PDFV.hitIdx = -1; PDFV.text = null;
    PDFV.vis = new Set(); PDFV.rendered = new Set(); PDFV._est = null;
    $('#pages').innerHTML = '';        // 清掉上一次的页容器（重新加载/切换文件时）
    $('#pages').className = '';        // 清掉 mode-double / mode-book / zoomed 残留
    if (!window.pdfjsLib) { $('#pages').innerHTML = '<p class="sub">PDF 组件加载失败（本地 PDF.js 缺失）</p>'; return; }
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
    // URL 模式用 Range 流式拉取（第一页先出）；data 模式一次性加载（PPT 转换件）。
    // 解析/下载期间盖加载提示：大文件这段可达十几秒，纯空白会被当成"打不开"。
    const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
    showDocLoading('正在加载文档…');
    const lt = pdfjsLib.getDocument(
      src.url ? { url: src.url, rangeChunkSize: 1048576 } : { data: src.data }
    );
    lt.onProgress = (d) => {
      if (!d || !d.loaded) return;
      if (d.total) updateDocLoading('正在加载文档… ' + Math.min(100, Math.round(d.loaded / d.total * 100)) + '%（' + fmtMB(d.loaded) + ' / ' + fmtMB(d.total) + '）');
      else updateDocLoading('正在加载文档… 已加载 ' + fmtMB(d.loaded));
    };
    try {
      PDFV.doc = await lt.promise;
    } catch (e) {
      hideDocLoading();
      $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败'; showGate('<p class="sub">' + (failMsg || 'PDF 加载失败') + '</p>'); return;
    }
    pdfDoc = PDFV.doc;
    PDFV.total = totalPages = PDFV.doc.numPages;
    initPdfReader();
    const limit = previewPages && previewPages < totalPages ? previewPages : totalPages;
    PDFV.limit = limit;
    // 关键：先「铺占位页 + 建缩略图」，再由观察器惰性渲染可见页。
    // 旧实现是 await 逐页渲染到 limit 之后才 buildThumbs()，遇到 791 页的大文档时
    // 缩略图抽屉会长时间空白（本次修的 bug），而且会一次性把全部页栅格化，内存直接爆掉。
    const est = await pdfEstimateSize();
    PDFV._est = { w: est.w, h: est.h };
    pdfBuildPages(1, limit);
    if (est.page) PDFV.pages[1].page = est.page;      // 第 1 页页对象已经拿到，别再取一次
    // 预览页数限制：未渲染的后续页暂不展示；如需密码保护则显示解锁表单
    if (limit < totalPages) {
      if (needProtect) renderUnlockBox(limit, totalPages);
      else {
        const tip = document.createElement('div');
        tip.className = 'sub';
        tip.style.cssText = 'text-align:center;padding:24px;color:var(--danger);font-weight:600;width:100%';
        tip.textContent = `分享者限制仅可预览前 ${limit} 页；后续 ${totalPages - limit} 页未设置查看密码，如需完整内容请联系分享者`;
        $('#pages').appendChild(tip);
      }
    }
    pdfFitWidth();          // 初始进入自动适应宽度（手机竖屏下比 100% 更好用）
    // 首次适宽的宽度可能取自「窗口竖向滚动条还没出现」的瞬间（页面铺完才占掉 15px），
    // 结果会差十几 px（宽屏表现为右侧露出一条横向滚动）。渲染稳定后再校正一次；
    // 用户若已手动缩放（autoFit=false）则不打扰。
    setTimeout(() => { if (PDFV.autoFit) pdfFitWidth(); }, 400);
    buildThumbs();          // 缩略图立刻可用，不必等页面渲染完
    obsPages();             // 惰性渲染可见页
    queuePage(1, pdfNeedScale());
    pdfTrackPage();
    hideDocLoading();       // 占位页已铺好、第一页开始渲染：撤掉整层提示，未渲完的页由骨架动画接管
}

// PPT：后端 LibreOffice 转 PDF 后按 PDF 查看器打开（缩放/拖移/试看/水印全套复用）。
// 服务器未装转换组件时后端返回 404+说明，降级为下载提示。
async function loadSlide() {
  try {
    const r = await fetch('/api/slide/' + shareId + '?at=' + accessToken);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      $('#gate').style.display = 'block'; $('#gateTitle').textContent = '无法在线预览';
      showGate('<p class="sub">' + escapeHtml(d.message || '该 PPT 暂不支持在线预览') + '</p>');
      return;
    }
    const data = await r.arrayBuffer();
    await loadPdfFromUrl({ data }, '幻灯片加载失败');
  } catch (e) {
    $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败'; showGate('<p class="sub">幻灯片加载失败，请稍后重试</p>');
  }
}

// Excel：前端 SheetJS 解析，多 Sheet 标签 + HTML 表格（水印层与禁复制约束照常生效）
async function loadSheet() {
  try {
    if (!window.XLSX) throw new Error('表格组件缺失');
    const r = await fetch('/api/content/' + shareId + '?at=' + accessToken);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const tabs = $('#sheetTabs'), body = $('#sheetBody');
    tabs.innerHTML = '';
    const names = wb.SheetNames;
    const show = (idx) => {
      tabs.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === idx));
      // sticker:false 去掉内联样式依赖；表格样式统一由 .sheet-body CSS 控制
      body.innerHTML = XLSX.utils.sheet_to_html(wb.Sheets[names[idx]], { editable: false });
      body.parentElement.scrollTop = 0;
    };
    names.forEach((n, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = n;
      b.addEventListener('click', () => show(i));
      tabs.appendChild(b);
    });
    show(0);
    $('#sheetWrap').style.display = 'block';
  } catch (e) {
    $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败'; showGate('<p class="sub">表格加载失败：' + escapeHtml(e.message || '') + '</p>');
  }
}

async function loadContent(k) {
  if (k === 'pdf') {
    await loadPdfFromUrl({ url: '/api/content/' + shareId + '?at=' + accessToken }, 'PDF 加载失败或被拒绝');
    return;
  }

  if (k === 'slide') { await loadSlide(); return; }

  if (k === 'sheet') { await loadSheet(); return; }

  if (k === 'image') {
    // 先探测后端是否已有降采样预览（超大图缓存）：有则直接用小图（省流量 + 避开移动端纹理上限），无则用原图
    let srcUrl = '/api/content/' + shareId + '?at=' + accessToken;
    try {
      const probe = await fetch('/api/preview/' + shareId + '?at=' + accessToken);
      if (probe.ok) {
        const blob = await probe.blob();
        srcUrl = URL.createObjectURL(blob);
      }
    } catch (e) { /* 探测失败用原图 */ }
    // 直接给 <img> 设 URL：浏览器原生支持 Range 与缓存，超大图首屏更快、且可复用服务端字节区间
    const img = document.createElement('img');
    img.src = srcUrl;
    img.decoding = 'async';   // 解码不阻塞主线程
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
    showDocLoading('正在加载文档…');
    try {
      const r = await fetch('/api/content/' + shareId + '?at=' + accessToken);
      if (!r.ok) {
        // 会话过期/分享失效时后端返回 JSON 错误，绝不能把错误报文当 HTML 渲染进正文
        hideDocLoading();
        const d = await r.json().catch(() => ({}));
        $('#gate').style.display = 'block'; $('#gateTitle').textContent = '无法加载';
        showGate('<p class="sub" style="text-align:center">' + escapeHtml(d.message || '文档加载失败，会话可能已过期，请刷新页面重试') + '</p>');
        return;
      }
      const html = await r.text();
      $('#docxWrap').style.display = 'block';
      $('#docxBody').innerHTML = html;
    } catch (e) {
      hideDocLoading();
      $('#gate').style.display = 'block'; $('#gateTitle').textContent = '加载失败';
      showGate('<p class="sub" style="text-align:center">网络异常，文档加载失败，请刷新重试</p>');
      return;
    }
    hideDocLoading();
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
  pdfCrispCap: 4,           // 最高栅格倍率：放大到多少倍就按需重渲，同时是单页内存上限
  pdfCrispMargin: 0.2,      // 清晰度判定余量（renderScale 达到 need-margin 即视为够清晰）
  pdfCrispDebounce: 220,    // 停止缩放后多久重渲染可见页（ms）
  stepIn: 1.25,             // 工具条「+」按钮倍率步进
  stepOut: 0.8,             // 工具条「-」按钮倍率步进
  wheelPdf: 1.1,            // PDF 滚轮（Ctrl/⌘+滚轮）每格倍率
  wheelImg: 1.12,           // 图片滚轮每格倍率
  dblClickToggle: 2,        // 图片双击在 1× 与该值之间切换
  thumbScale: 0.22,         // 缩略图栅格化倍率
};
const MIN_DISP = ZOOM_CFG.min, MAX_DISP = ZOOM_CFG.max;
let crispTimer = null;
let zbar = null;
let zoomMode = null;                  // 'pdf' | 'image' | null
let imgScale = 1, imgX = 0, imgY = 0, imgContent = null, imgStage = null;
let imgZoomReady = false;
function ensureZbar() {
  if (zbar) { zbar.style.display = 'flex'; return zbar; }
  zbar = document.createElement('div');
  zbar.className = 'zbar';
  zbar.innerHTML =
    '<button class="zbtn" data-act="out" title="缩小">−</button>' +
    '<span class="z-pct">100%</span>' +
    '<button class="zbtn" data-act="in" title="放大">+</button>' +
    '<span class="zsep"></span>' +
    '<button class="zbtn" data-act="fit" title="适应宽度">适宽</button>' +
    '<button class="zbtn" data-act="reset" title="实际大小">100%</button>' +
    '<button class="zbtn" data-act="full" title="全屏">全屏</button>';
  zbar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'in') zoomStep(ZOOM_CFG.stepIn);
    else if (a === 'out') zoomStep(ZOOM_CFG.stepOut);
    else if (a === 'fit') zoomFit();
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
function zoomStep(f) { if (zoomMode === 'pdf') pdfSetDisplay(PDFV.display * f); else if (zoomMode === 'image') imgSetScale(imgScale * f); }
function zoomReset() { if (zoomMode === 'pdf') pdfSetDisplay(1); else if (zoomMode === 'image') imgSetScale(1); }
function zoomFit() { if (zoomMode === 'pdf') pdfFitWidth(); else if (zoomMode === 'image') imgFit(); }

// ---- PDF：改 canvas 显示尺寸实现缩放，纵向原生滚动，宽页可原生横滑；放大到一定程度时重渲染可见页保持清晰 ----
function pdfEnsureCrisp() {
  if (crispTimer) clearTimeout(crispTimer);
  crispTimer = setTimeout(async () => {
    const needBase = pdfNeedScale();
    // 只处理「当前在可视区」的页：旧实现对每一页都做 getBoundingClientRect，
    // 791 页时每次缩放要读近 800 次布局 —— 换成观察器维护的可见页集合后基本零成本。
    let list = Array.from(PDFV.vis || []);
    if (!list.length) {
      for (let i = Math.max(1, PDFV.cur - 2); i <= Math.min(PDFV.total, PDFV.cur + 2); i++) list.push(i);
    }
    for (const i of list) {
      const rec = PDFV.pages[i];
      if (!rec || !rec.canvas || !rec.wrap.parentNode) continue;
      // need 按每页实际尺寸钳制：超大页受 GPU 上限截断后 renderScale 达不到原始 need，
      // 不钳制会导致每次缩放后都对该页反复重渲
      const need = pdfCapScale(rec.vp1, needBase);
      // 够清晰就跳过；但若当前 canvas 远超所需（例如从 400% 缩回适宽后仍挂着高分辨率像素），
      // 也重渲一次把像素降下来还内存。阈值放到 3 倍，正常缩放（≤3× 超采样）不会来回重渲、不闪。
      if (rec.renderScale >= need - ZOOM_CFG.pdfCrispMargin && rec.renderScale <= need * 3) continue;
      await queuePage(i, need);
    }
    pdfRefreshHl();                                       // 高亮坐标依赖显示倍率，缩放后统一重绘
    pdfTrackPage();
  }, ZOOM_CFG.pdfCrispDebounce);
}
function pdfSetDisplay(v, auto) {
  // auto=true 表示这次是「适宽」算出来的倍数（窗口尺寸变化时允许自动重算）；
  // 用户手动放大/缩小/滚轮/捏合走 auto 缺省 undefined → 记为手动，之后不再被 resize 自动覆盖。
  PDFV.autoFit = !!auto;
  // 上下限都用动态值：超大文档适宽可能远低于 0.5，硬上下限会让"适宽后一缩小反而变大 / 放大没尽头"
  PDFV.display = Math.min(PDFV.maxDisp || MAX_DISP, Math.max(PDFV.minDisp || MIN_DISP, v));
  $('#pages').classList.add('zoomed');
  pdfApplyWidths();
  setZpct(PDFV.display);
  pdfEnsureCrisp();
  // 内容超宽时鼠标悬停显示 grab 光标，提示可按住拖移
  const st = $('#pdfStage');
  if (st) st.classList.toggle('grab', st.scrollWidth > st.clientWidth + 1);
}
// 适应宽度：单页=一页宽铺满容器；双页/书籍=两页并排铺满。手机竖屏下比 100% 更实用。
function pdfFitWidth() {
  const stage = $('#pdfStage') || $('#pages').parentNode;
  if (!stage) return;
  const avail = (stage.clientWidth || window.innerWidth) - 8;
  const cols = PDFV.view === 'single' ? 1 : 2;
  let maxW = 0;
  PDFV.pages.forEach((r) => { if (r && r.baseW > maxW) maxW = r.baseW; });
  if (!maxW) return;
  const target = (avail - (cols > 1 ? 12 : 0)) / cols;
  const disp = target / maxW;
  // 缩放范围跟随适宽结果：下限=适宽一半，上限=适宽×8（不低于 1×，不超过全局 4×），
  // 避免"适宽 8% 后还能一路放大到 400%"这种没有尽头的跨度
  PDFV.minDisp = Math.min(MIN_DISP, disp * 0.5);
  PDFV.maxDisp = Math.min(MAX_DISP, Math.max(1, disp * 8));
  pdfSetDisplay(disp, true);
}
function initPdfReader() {
  zoomMode = 'pdf';
  if (!$('#pdfStage')) {
    const stage = document.createElement('div'); stage.id = 'pdfStage';
    const pages = $('#pages');
    pages.parentNode.insertBefore(stage, pages);
    stage.appendChild(pages);
    pages.classList.add('zoomed');
    // 桌面：Ctrl/⌘ + 滚轮缩放（不影响纵向滚动）
    stage.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      pdfSetDisplay(PDFV.display * (e.deltaY < 0 ? ZOOM_CFG.wheelPdf : 1 / ZOOM_CFG.wheelPdf));
    }, { passive: false });
    // 触屏：双指捏合缩放
    let pinch = 0;
    stage.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = touchDist(e); }, { passive: true });
    stage.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        const d = touchDist(e);
        pdfSetDisplay(PDFV.display * (d / pinch));
        pinch = d;
      }
    }, { passive: false });
    stage.addEventListener('touchend', () => { pinch = 0; });
    // 桌面：grab 拖拽平移。放大后内容超出可视区时，按住直接拖画面（横向滚 stage、纵向滚页面），
    // 不必找底部滚动条；未放大（内容没超宽）时不接管，保持普通光标。
    let pd = null;   // { x, y, sl }
    stage.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (stage.scrollWidth <= stage.clientWidth + 1) return;   // 没超宽，无需拖移
      pd = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft };
      stage.classList.add('grabbing');
      e.preventDefault();                                        // 防止拖成文本选择（PDF 无文本层，安全）
    });
    window.addEventListener('mousemove', (e) => {
      if (!pd) return;
      stage.scrollLeft = pd.sl - (e.clientX - pd.x);
      window.scrollBy(0, -(e.clientY - pd.y));
      pd.y = e.clientY;                                          // 纵向增量累积（scrollBy 后以新位置为基准）
    });
    window.addEventListener('mouseup', () => {
      if (!pd) return;
      pd = null;
      stage.classList.remove('grabbing');
    });
  }
  ensureZbar();
}

// ---------- 页码 / 当前页 ----------
function updatePageUI() {
  const inp = $('#vPageIn');
  if (inp && document.activeElement !== inp) inp.value = PDFV.cur;
  const t = $('#vPageTotal');
  if (t) t.textContent = '/ ' + PDFV.total;
  const pr = $('#prPage');
  if (pr) pr.textContent = PDFV.cur + ' / ' + PDFV.total;
  const st = $('#vStatus');
  if (st) st.textContent = '第 ' + PDFV.cur + ' 页 · 共 ' + PDFV.total + ' 页';
  // 只切换「上一个/当前」两个缩略图（旧实现每次都把全部缩略图 classList.remove 一遍，
  // 791 页文档滚动时每个页码变化都要动 791 个节点，明显拖慢滚动）
  const prev = PDFV.thumbs[lastActiveThumb];
  if (prev && prev.el && lastActiveThumb !== PDFV.cur) prev.el.classList.remove('active');
  const cur = PDFV.thumbs[PDFV.cur];
  if (cur && cur.el) { cur.el.classList.add('active'); lastActiveThumb = PDFV.cur; }
}
function pdfTrackPage() {
  if (!PDFV.total) return;
  const n = PDFV.total;
  const anchor = window.innerHeight * 0.45;
  const topOf = (i) => { const r = PDFV.pages[i]; return (r && r.wrap.parentNode) ? r.wrap.getBoundingClientRect().top : Infinity; };
  // top(i) 随 i 单调不减 → 二分找「最后一个 top<=anchor」的页。
  // 旧实现每滚一下都对全部页做 getBoundingClientRect，791 页时每次滚动读近 800 次布局（明显卡顿），
  // 二分后固定约 10 次，且大幅拖动滚动条也能准确定位。
  let lo = 1, hi = n, cur = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topOf(mid) <= anchor) { cur = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (cur !== PDFV.cur) {
    PDFV.cur = cur; updatePageUI();
    // 进度上报收敛到「页码真的变了」这一刻：渲染每页都上报会把后台日志刷满
    if (cur !== lastPage) { lastPage = cur; report('progress', 'p' + cur + '/' + PDFV.total); }
  }
}
let trackRaf = 0;
window.addEventListener('scroll', () => {
  if (trackRaf) return;
  trackRaf = requestAnimationFrame(() => { trackRaf = 0; pdfTrackPage(); sweepReleased(); });
}, { passive: true });
window.addEventListener('resize', () => { pdfTrackPage(); });
// 窗口尺寸变化（拉大窗口 / 外接显示器 / 关掉侧栏）后，仍处于「适宽」状态就重新适配：
// 否则内容停在旧倍数，宽屏右侧是一大片空白。用户手动缩放过（PDFV.autoFit=false）则不打扰。
let refitTimer = 0;
window.addEventListener('resize', () => {
  if (zoomMode !== 'pdf' || !PDFV.autoFit) return;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => { if (PDFV.autoFit) pdfFitWidth(); }, 140);
});

function pdfGoPage(n, smooth) {
  n = Math.max(1, Math.min(PDFV.total, Math.round(n) || 1));
  const rec = PDFV.pages[n];
  if (!rec) { toast('该页不可预览'); return; }
  const vh = $('.vhead');
  const off = (vh ? vh.getBoundingClientRect().height : 0) + 8;
  const y = rec.wrap.getBoundingClientRect().top + window.scrollY - off;
  window.scrollTo({ top: y, behavior: smooth ? 'smooth' : 'auto' });
  PDFV.cur = n; updatePageUI();
}

// ---------- 旋转 / 视图模式 ----------
async function pdfRotate(delta) {
  if (!PDFV.doc) return;
  PDFV.rot = ((PDFV.rot + delta) % 360 + 360) % 360;
  const keep = PDFV.cur;
  // 只「失效 + 换占位尺寸」，不立刻全量重渲染：可见页随后由观察器按需补渲。
  // 旧实现对每一页都 await 重渲染，791 页文档点一次旋转要等到天荒地老。
  for (let i = 1; i <= PDFV.limit; i++) {
    const rec = PDFV.pages[i]; if (!rec) continue;
    rec.renderScale = 0;
    const t = rec.baseW; rec.baseW = rec.baseH; rec.baseH = t;   // 宽高互换占位，避免旋转瞬间布局跳动
    rec.canvas.width = 1; rec.canvas.height = 1;                // 释放旧画布，避免 pdf.js 尺寸校验报错
    rec.wrap.classList.remove('done');                          // 旋转后需重渲，重新露出骨架
    pdfSizePage(rec);
  }
  pdfSetView(PDFV.view);        // 重新排版（旋转后宽高互换，需重算适配）
  PDFV.rendered.clear();        // 全部已失效，回收集合同步清空
  pdfGoPage(keep);
  obsPages();                   // 重新评估可见页并补渲
  rebuildThumbs();
  toast('已旋转 ' + PDFV.rot + '°');
}
function pdfSetView(v) {
  PDFV.view = v;
  const el = $('#pages');
  el.classList.toggle('mode-double', v === 'double');
  el.classList.toggle('mode-book', v === 'book');
  pdfFitWidth();
}

// ---------- 缩略图抽屉 ----------
let lastActiveThumb = 0;
function buildThumbs() {
  const list = $('#tList');
  if (!list || !PDFV.doc) return;
  list.innerHTML = '';
  PDFV.thumbs = [];
  lastActiveThumb = 0;
  const total = PDFV.limit || PDFV.total;
  // 缩略图占位：canvas 只给 1×1 后备存储（不占内存），用 aspect-ratio 撑出与页面同比例的高度。
  // 791 页若都按 thumbScale 分配像素，光占位就要几十 MB；这样处理后只有真正渲染过的缩略图才占内存。
  const est = PDFV._est || { w: 595, h: 842 };
  const tw = Math.max(1, Math.round(est.w * ZOOM_CFG.thumbScale));
  const th = Math.max(1, Math.round(est.h * ZOOM_CFG.thumbScale));
  for (let i = 1; i <= total; i++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'titem'; b.dataset.page = i;
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    c.style.aspectRatio = tw + ' / ' + th;
    const n = document.createElement('b'); n.textContent = i;
    b.appendChild(c); b.appendChild(n);
    b.addEventListener('click', () => { pdfGoPage(i, true); closeThumbs(); });
    list.appendChild(b);
    PDFV.thumbs[i] = { el: b, canvas: c, done: false };
  }
  updatePageUI();
  obsThumbs();
}
let thumbObs = null;
function obsThumbs() {
  if (thumbObs) thumbObs.disconnect();
  if (!('IntersectionObserver' in window)) { PDFV.thumbs.forEach((t, i) => { if (t) queueThumb(i); }); return; }
  // 注意：观察基准用「视口」而不是 #tPane。
  // 抽屉关闭时靠 transform 移到屏幕外，用视口做基准能天然判为「不可见」→ 不渲染；
  // 抽屉一打开，缩略图进入视口才会触发渲染。用 #tPane 当 root 时关闭状态下容易判定异常。
  thumbObs = new IntersectionObserver((ents) => {
    ents.forEach((en) => {
      const i = +en.target.dataset.page;
      if (en.isIntersecting) queueThumb(i);
      else releaseThumb(i);        // 滚出抽屉视口就释放，791 页也不会把缩略图全驻留内存
    });
  }, { rootMargin: '200px 0px' });
  PDFV.thumbs.forEach((t) => { if (t && t.el) thumbObs.observe(t.el); });
}
// 串行队列：避免同一 page 对象被并发渲染（pdf.js 对同页并发 render 会互相干扰）
let thumbQ = Promise.resolve();
function queueThumb(i) {
  const t = PDFV.thumbs[i];
  if (!t || t.done) return;
  t.done = true;
  thumbQ = thumbQ.then(() => renderThumb(i)).catch(() => {});
}
// 缩略图目标宽度：按抽屉实际可用宽取，而不是页面原始尺寸 × thumbScale。
// 工程图/海报类超大页面按 0.22 倍会给每张缩略图分配上百万像素（单张几 MB~十几 MB），
// 抽屉里同时挂着十几张就白耗几十 MB —— 固定到面板宽度后每张只要 ~0.3MB。
let thumbWCache = 0;
function thumbFitWidth() {
  if (thumbWCache) return thumbWCache;
  const el = $('#tList');
  const w = el ? el.clientWidth - 14 : 0;         // 减去 .titem 的 padding/border 余量
  thumbWCache = Math.min(320, Math.max(96, w || 180));
  return thumbWCache;
}
async function renderThumb(i) {
  const t = PDFV.thumbs[i];
  if (!t || !t.done) return;                    // 已被释放/重排队则跳过这次渲染
  const rec = PDFV.pages[i];
  const pg = (rec && rec.page) || await PDFV.doc.getPage(i);
  const rot = ((pg.rotate || 0) + PDFV.rot) % 360;
  const vp0 = pg.getViewport({ scale: 1, rotation: rot });
  const ts = Math.min(ZOOM_CFG.thumbScale, thumbFitWidth() / Math.max(1, vp0.width));
  const vp = pg.getViewport({ scale: ts, rotation: rot });
  t.canvas.width = Math.ceil(vp.width);
  t.canvas.height = Math.ceil(vp.height);
  t.canvas.style.aspectRatio = Math.ceil(vp.width) + ' / ' + Math.ceil(vp.height);
  try {
    await pg.render({ canvasContext: t.canvas.getContext('2d'), viewport: vp }).promise;
    thumbHintDone();                  // 首张缩略图出来就收起「正在生成缩略图…」提示
  } catch (e) { t.done = false; }   // 失败允许下次进入视口时重试
}
function releaseThumb(i) {
  const t = PDFV.thumbs[i];
  if (!t || !t.done) return;
  t.canvas.width = 1; t.canvas.height = 1;   // 只回收像素内存；aspect-ratio 仍撑着占位高度，不会跳版
  t.done = false;
}
function rebuildThumbs() { thumbWCache = 0; buildThumbs(); }   // 抽屉宽度可能随窗口变，缓存要清
function openThumbs() {
  const pane = $('#tPane');
  pane.classList.add('open');
  pane.removeAttribute('inert');
  $('#tMask').hidden = false;
  $('#thumbBtn').classList.add('on');
  obsThumbs();          // 抽屉位置变化后重新评估可见缩略图，保证一打开就开始渲染
  const cur = PDFV.thumbs[PDFV.cur];
  if (cur && cur.el) setTimeout(() => {
    // 直接改抽屉滚动位置，避免 scrollIntoView 把主文档也一起滚走
    pane.scrollTop = cur.el.offsetTop - pane.clientHeight / 2 + cur.el.offsetHeight / 2;
  }, 60);
}
function closeThumbs() {
  const pane = $('#tPane');
  pane.classList.remove('open');
  pane.setAttribute('inert', '');   // 收起后不可聚焦，避免键盘 Tab 跑进看不见的抽屉
  $('#tMask').hidden = true;
  $('#thumbBtn').classList.remove('on');
}
function thumbHintDone() { const h = $('#tHint'); if (h) h.style.display = 'none'; }
function toggleThumbs() { $('#tPane').classList.contains('open') ? closeThumbs() : openThumbs(); }

// ---------- 文档内搜索（安全版：只定位，不给文字层）----------
let searchOpen = false;
function openSearch() {
  if (kind !== 'pdf' || !PDFV.doc) { toast('当前文件不支持文档内查找'); return; }
  searchOpen = true;
  $('#sBar').hidden = false;
  setTimeout(() => $('#sIn').focus(), 30);
  if (PDFV.kw) $('#sIn').value = PDFV.kw;
}
function closeSearch() {
  searchOpen = false;
  $('#sBar').hidden = true;
  $('#sIn').value = '';
  PDFV.hits = []; PDFV.hitIdx = -1; PDFV.kw = '';
  $('#sInfo').textContent = '';
  $('#sInfo').classList.remove('none');
  pdfRefreshHl();
}
// 建立文字索引：只把文字读进内存，绝不写进 DOM —— 这是「能搜到但选不中」的关键
async function ensureTextIndex(onProgress) {
  if (PDFV.text) return PDFV.text;
  const out = [];
  const max = PDFV.limit || PDFV.total;
  for (let i = 1; i <= max; i++) {
    try {
      const rec = PDFV.pages[i];
      // 惰性渲染下 rec 存在但 rec.page 可能还是 null（该页还没进过可视区），必须回源取一次
      const pg = (rec && rec.page) || await PDFV.doc.getPage(i);
      if (rec && !rec.page) rec.page = pg;                  // 顺手缓存，省得渲染时再取
      const tc = await pg.getTextContent();
      const items = [];
      let str = '';
      for (const it of tc.items) {
        if (!it.str) continue;
        const start = str.length;
        str += it.str;
        items.push({ start, end: str.length, it });
      }
      out[i] = { str: str.toLowerCase(), raw: str, items };
    } catch (e) { out[i] = { str: '', raw: '', items: [] }; }
    if (onProgress && (i % 8 === 0 || i === max)) onProgress(i, max);
  }
  PDFV.text = out;
  return out;
}
async function doSearch(kw) {
  const info = $('#sInfo');
  kw = (kw || '').trim();
  PDFV.kw = kw;
  PDFV.hits = []; PDFV.hitIdx = -1;
  if (!kw) { info.textContent = ''; pdfRefreshHl(); return; }
  info.textContent = '查找中…';
  const idx = await ensureTextIndex((i, n) => { info.textContent = '建立索引 ' + i + '/' + n + '…'; });
  const needle = kw.toLowerCase();
  const hits = [];
  const max = PDFV.limit || PDFV.total;
  for (let i = 1; i <= max; i++) {
    const rec = idx[i]; if (!rec || !rec.str) continue;
    let from = 0;
    while (true) {
      const pos = rec.str.indexOf(needle, from);
      if (pos < 0) break;
      const rs = [];
      for (const e of rec.items) {
        if (pos + needle.length <= e.start || pos >= e.end) continue;
        const s0 = Math.max(pos, e.start) - e.start;
        const s1 = Math.min(pos + needle.length, e.end) - e.start;
        const rr = weightedRatio(e.it.str, s0, s1);
        rs.push({ it: e.it, s0f: rr[0], s1f: rr[1] });
      }
      if (rs.length) hits.push({ page: i, rs });
      from = pos + Math.max(1, needle.length);
      if (hits.length >= 300) break;
    }
    if (hits.length >= 300) break;
  }
  PDFV.hits = hits;
  if (!hits.length) { info.textContent = '无结果'; info.classList.add('none'); pdfRefreshHl(); return; }
  info.classList.remove('none');
  PDFV.hitIdx = 0;
  gotoHit(0);
  report('search', kw.slice(0, 60));    // 搜索词上报，便于分享者了解客户关注点
}
function gotoHit(k) {
  if (!PDFV.hits.length) return;
  k = (k + PDFV.hits.length) % PDFV.hits.length;
  PDFV.hitIdx = k;
  const h = PDFV.hits[k];
  $('#sInfo').textContent = (k + 1) + ' / ' + PDFV.hits.length + ' · 第 ' + h.page + ' 页';
  pdfRefreshHl();
  pdfGoPage(h.page, true);
}
// 文本项 → 屏幕包围盒：用 pdf.js textLayer 同款矩阵变换，兼容任意旋转。
// 两个易错点（本项目实测踩过）：
//   ① 宽度是 item.width × viewport.scale —— item.width 已含字形缩放，再乘 hypot(tx[0],tx[1]) 会放大到几十倍；
//   ② 行高是 hypot(tx[2],tx[3])（即字号 px），而不是 item.height × sy；
//   ③ 字形在基线「上方」，所以是基线 + 垂直单位向量 × 行高，减号会让高亮块跑到下一行。
function itemAABB(item, vp, s0f, s1f) {
  const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
  const sx = Math.hypot(tx[0], tx[1]) || 1;
  const sy = Math.hypot(tx[2], tx[3]) || 1;
  const ux = tx[0] / sx, uy = tx[1] / sx;     // 文本前进方向单位向量
  const vx = tx[2] / sy, vy = tx[3] / sy;     // 字形向上方向单位向量
  const W = (item.width || 0) * vp.scale;
  const H = sy;
  const ax = tx[4] + ux * W * s0f, ay = tx[5] + uy * W * s0f;
  const bx = tx[4] + ux * W * s1f, by = tx[5] + uy * W * s1f;
  const pts = [[ax, ay], [bx, by], [ax + vx * H, ay + vy * H], [bx + vx * H, by + vy * H]];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  const y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// 字符宽度权重：全角算 1、半角算 0.5。中文 PDF 里常出现「端口 445」这类中英混排，
// 直接按字符个数取比例会让高亮块明显偏移，按权重换算能贴合到字上。
function charWeight(ch) {
  const c = ch.codePointAt(0);
  const full =
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd);
  return full ? 1 : 0.5;
}
function weightedRatio(str, i0, i1) {
  let total = 0, before = 0, span = 0, i = 0;
  for (const ch of str) {   // for...of 按码点遍历，与 indexOf 的 UTF-16 下标在 BMP 内一致
    const w = charWeight(ch);
    if (i < i0) before += w;
    if (i >= i0 && i < i1) span += w;
    total += w;
    i++;
  }
  if (!total) return [0, 1];
  return [before / total, (before + span) / total];
}
let hlPages = [];   // 上一次真正画过高亮的页，重绘时只清这些页（避免每次都遍历全部页）
function pdfRefreshHl() {
  const touch = new Set(hlPages);
  PDFV.hits.forEach((h) => touch.add(h.page));
  touch.forEach((p) => { const r = PDFV.pages[p]; if (r && r.hl) r.hl.innerHTML = ''; });
  hlPages = [];
  if (!PDFV.hits.length) return;
  const disp = PDFV.display;
  PDFV.hits.forEach((h, hi) => {
    const rec = PDFV.pages[h.page];
    if (!rec || !rec.vp1 || !rec.renderScale) return;   // 该页当前没渲染（或已被释放）→ 等它渲染完成时补绘
    h.rs.forEach((r) => {
      let b;
      try { b = itemAABB(r.it, rec.vp1, r.s0f, r.s1f); } catch (e) { return; }
      if (!isFinite(b.x) || !isFinite(b.y)) return;
      const el = document.createElement('i');
      el.style.left = (b.x * disp) + 'px';
      el.style.top = (b.y * disp) + 'px';
      el.style.width = Math.max(2, b.w * disp) + 'px';
      el.style.height = Math.max(2, b.h * disp) + 'px';
      if (hi === PDFV.hitIdx) el.className = 'cur';
      rec.hl.appendChild(el);
    });
    hlPages.push(h.page);
  });
}

// ---------- 工具栏 ----------
function initToolbar(k) {
  const bar = $('#vtool');
  if (!bar) return;
  bar.hidden = false;
  // data-for 声明每个按钮适用于哪些文件类型；不适用的直接隐藏，避免点了没反应
  bar.querySelectorAll('[data-for]').forEach((el) => {
    el.hidden = el.dataset.for.split(',').indexOf(k) < 0;
  });
  $('#thumbBtn').hidden = (k !== 'pdf' && k !== 'slide');   // PPT 转换件也是 PDF 渲染，有缩略图
  bindToolbar();
}
function bindToolbar() {
  const bind = (id, fn) => { const el = $(id); if (el && !el.dataset.bound) { el.dataset.bound = '1'; el.addEventListener('click', fn); } };
  bind('#thumbBtn', toggleThumbs);
  bind('#vSearch', () => { searchOpen ? closeSearch() : openSearch(); });
  bind('#vRotate', () => pdfRotate(90));
  bind('#vMore', openMore);
  bind('#tMask', closeThumbs);
  bind('#sClose', closeSearch);
  bind('#sPrev', () => gotoHit(PDFV.hitIdx - 1));
  bind('#sNext', () => gotoHit(PDFV.hitIdx + 1));
  bind('#prPrev', () => pdfGoPage(PDFV.cur - 1, true));
  bind('#prNext', () => pdfGoPage(PDFV.cur + 1, true));
  bind('#prExit', presentExit);
  bind('#prHotL', () => pdfGoPage(PDFV.cur - 1, true));
  bind('#prHotR', () => pdfGoPage(PDFV.cur + 1, true));
  // 页码输入
  const pin = $('#vPageIn');
  if (pin && !pin.dataset.bound) {
    pin.dataset.bound = '1';
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { pdfGoPage(parseInt(pin.value, 10)); pin.blur(); }
      if (e.key === 'Escape') { pin.value = PDFV.cur; pin.blur(); }
    });
    pin.addEventListener('blur', () => { pin.value = PDFV.cur; });
  }
  // 搜索输入
  const sin = $('#sIn');
  if (sin && !sin.dataset.bound) {
    sin.dataset.bound = '1';
    let t = null;
    sin.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => doSearch(sin.value), 380); });
    sin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(t);
        const kw = sin.value.trim();
        // 命中集未变时回车＝跳到下一处（Shift+回车＝上一处），变了才重新查找
        if (PDFV.hits.length && PDFV.kw === kw) gotoHit(PDFV.hitIdx + (e.shiftKey ? -1 : 1));
        else doSearch(kw);
      }
      if (e.key === 'Escape') closeSearch();
    });
  }
  // 底部面板关闭
  const sheet = $('#mSheet');
  if (sheet && !sheet.dataset.bound) {
    sheet.dataset.bound = '1';
    sheet.addEventListener('click', (e) => { if (e.target.dataset.close) closeMore(); });
  }
  // 演示模式键盘 / 全屏同步：document 级监听只允许挂一次
  // （bindToolbar 可能被多次调用，重复绑定会导致按一次方向键翻多页）
  if (!bindToolbar._docBound) {
    bindToolbar._docBound = true;
    document.addEventListener('keydown', (e) => {
      if (!PDFV.present) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); pdfGoPage(PDFV.cur - 1, true); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); pdfGoPage(PDFV.cur + 1, true); }
      else if (e.key === 'Escape') presentExit();
    });
    // 用户按 Esc / 系统手势退出全屏时，同步退出演示态，否则会留下一条收不起来的底栏
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && PDFV.present) presentExit();
    });
  }
}

// ---------- 更多面板 / 文档属性 ----------
function closeMore() { $('#mSheet').hidden = true; $('#msBody').innerHTML = ''; }
function openMore() {
  const isPdf = kind === 'pdf' && !!PDFV.doc;
  const on = (v) => PDFV.view === v ? ' on' : '';
  $('#msBody').innerHTML =
    '<h3 class="ms-h">阅读设置</h3>' +
    (isPdf ?
      '<div class="ms-grp">旋转</div>' +
      '<div class="ms-row">' +
        '<button class="ms-b" data-act="rot-l">逆时针 90°</button>' +
        '<button class="ms-b" data-act="rot-r">顺时针 90°</button>' +
      '</div>' +
      '<div class="ms-grp">页面视图</div>' +
      '<div class="ms-row">' +
        '<button class="ms-b' + on('single') + '" data-act="view-single">单页</button>' +
        '<button class="ms-b' + on('double') + '" data-act="view-double">双页</button>' +
        '<button class="ms-b' + on('book') + '" data-act="view-book">书籍</button>' +
      '</div>' +
      '<div class="ms-grp">阅读</div>' +
      '<div class="ms-row">' +
        '<button class="ms-b" data-act="search">文档内查找</button>' +
        '<button class="ms-b" data-act="present">演示模式</button>' +
        '<button class="ms-b" data-act="info">文档属性</button>' +
      '</div>'
      : '<div class="ms-grp">阅读</div><div class="ms-row"><button class="ms-b" data-act="info">文档属性</button></div>');
  $('#mSheet').hidden = false;
  $('#msBody').querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'rot-l') { pdfRotate(-90); closeMore(); }
      else if (a === 'rot-r') { pdfRotate(90); closeMore(); }
      else if (a === 'view-single') { pdfSetView('single'); closeMore(); }
      else if (a === 'view-double') { pdfSetView('double'); closeMore(); }
      else if (a === 'view-book') { pdfSetView('book'); closeMore(); }
      else if (a === 'search') { closeMore(); openSearch(); }
      else if (a === 'present') { closeMore(); presentEnter(); }
      else if (a === 'info') openInfo();
    });
  });
}
function fmtKind(k) {
  return ({ pdf: 'PDF 文档', image: '图片', docx: 'Word 文档', source: '设计源文件' })[k] || '文件';
}
function fmtLeft() {
  if (!expiresIn) return '不限时';
  const ms = expiresIn - (Date.now() - sessionStart);
  if (ms <= 0) return '已结束';
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return m > 0 ? ('剩余 ' + m + ' 分钟') : ('剩余 ' + s + ' 秒');
}
// 文档属性：只呈现中性信息。遵守方案 B 的约定 —— 不在这里列「禁止复制/打印」等限制项，
// 避免让客户产生被防范的感觉（限制只在真正触发时提示）。
function openInfo() {
  const rows = [
    ['文件名称', docName],
    ['文件格式', fmtKind(kind)],
  ];
  if (kind === 'pdf' && PDFV.doc) {
    rows.push(['总页数', PDFV.total + ' 页']);
    rows.push(['当前页码', '第 ' + PDFV.cur + ' 页']);
    rows.push(['当前缩放', Math.round(PDFV.display * 100) + '%']);
  }
  rows.push(['本次阅读权限', fmtLeft()]);
  $('#msBody').innerHTML =
    '<h3 class="ms-h">文档属性</h3>' +
    rows.map((r) => '<div class="ms-info"><span>' + r[0] + '</span><span>' + escapeHtml(String(r[1] || '-')) + '</span></div>').join('') +
    '<div class="ms-row" style="margin-top:16px"><button class="ms-b" data-act="back">返回设置</button></div>';
  $('#mSheet').hidden = false;
  $('#msBody').querySelector('[data-act="back"]').addEventListener('click', openMore);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 演示模式 ----------
function presentEnter() {
  if (kind !== 'pdf' || !PDFV.doc) { toast('演示模式仅支持 PDF'); return; }
  PDFV.present = true;
  document.body.classList.add('present');
  closeSearch(); closeThumbs();
  if (document.documentElement.requestFullscreen) {
    const p = document.documentElement.requestFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
  setTimeout(() => { pdfGoPage(PDFV.cur, false); updatePageUI(); }, 120);
  $('#prPage').textContent = PDFV.cur + ' / ' + PDFV.total;
}
function presentExit() {
  PDFV.present = false;
  document.body.classList.remove('present');
  if (document.fullscreenElement && document.exitFullscreen) {
    const p = document.exitFullscreen();
    if (p && p.catch) p.catch(() => {});
  }
}

// ---- 图片：transform 缩放 + 拖移 + 捏合，基于原图像素故放大不损画质 ----
function imgApply() { if (imgContent) { imgContent.style.transform = `translate(${imgX}px,${imgY}px) scale(${imgScale})`; setZpct(imgScale); } }
// 图片动态缩放范围：适宽/适应窗口算出的比例可能远低于 0.5（超大印刷图），
// 固定 [0.5, 4] 会让缩放跨度没有尽头。适宽后：下限=适宽×0.5，上限=适宽×8（不低于 1×，不超全局 4×）。
let imgMinScale = ZOOM_CFG.min, imgMaxScale = ZOOM_CFG.max;
function imgSetScale(v) { imgScale = Math.min(imgMaxScale, Math.max(imgMinScale, v)); sizeStage(); imgClamp(); imgApply(); }
// stage 的可用区尺寸（父容器内宽 × 62vh）：不依赖 stage 自身当前尺寸（它会被 JS 内联缩小）
function stageAvail() {
  const p = imgStage.parentElement, pcs = getComputedStyle(p);
  return {
    w: Math.max(200, p.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight)),
    h: Math.max(200, Math.round(window.innerHeight * 0.62))
  };
}
// 让 stage 容器紧贴图片的视觉尺寸：竖图/小图不再左右留大白边（transform 不改变布局，
// 容器无法自动感知缩放后的视觉宽度，只能由 JS 按图片布局尺寸×当前倍率设置）。
// 图片显示尺寸小于可用区时容器收缩贴合；放大超出可用区时容器顶满（此时才需要拖移）。
function sizeStage() {
  if (!imgStage || !imgContent) return;
  const el = imgContent.querySelector('img'); if (!el || !el.offsetWidth) return;
  const av = stageAvail();
  const vw = el.offsetWidth * imgScale, vh = el.offsetHeight * imgScale;
  imgStage.style.width = Math.max(120, Math.min(av.w, vw)) + 'px';
  if (imgLongMode) {
    // 长图模式：高度=图片视觉高度（可远超视口，页面纵向滚动看全图）；触摸放开纵向给页面滚动
    imgStage.style.height = Math.max(120, vh) + 'px';
    imgStage.style.touchAction = 'pan-y';
  } else {
    imgStage.style.height = Math.max(120, Math.min(av.h, vh)) + 'px';
    imgStage.style.touchAction = 'none';
  }
}
// 竖长图模式（高/宽 > 2.2 且高度适配后过窄）：宽度撑满 + 容器高度=图片视觉高度（页面纵向滚动），
// 触摸纵向滑动交给页面滚动（像朋友圈长图），横向仍可拖移，双指捏合缩放保留
let imgLongMode = false;
function imgFit() {
  if (!imgStage || !imgContent) return;
  const av = stageAvail();
  const sw = av.w, sh = av.h;
  const imgEl = imgContent.querySelector('img'); if (!imgEl) return;
  const nw = imgEl.naturalWidth || imgEl.width, nh = imgEl.naturalHeight || imgEl.height;
  if (!nw || !nh) return;                       // 图片尺寸未知（未解码完），不猜
  // 适应窗口：宽高都装下（只缩小不放大于原尺寸）；位置统一交给 imgClamp 居中/夹边，
  // 避免 fit 手算偏移在异常布局下把图片平移出视口（超大图"打开看不到"的根因）
  imgScale = Math.min(sw / nw, sh / nh, 1);
  // 竖长图且高度适配后过窄 → 改用宽度撑满（页面滚动看全图），否则 7% 缩放什么也看不清
  if (nh / nw > 2.2 && (sh / nh) * nw < 320) {
    imgLongMode = true;
    imgScale = sw / nw;
  } else {
    imgLongMode = false;
    imgScale = Math.min(sw / nw, sh / nh, 1);
  }
  // 缩放范围跟随适宽结果（下限留一半余量；上限到 1× 原图像素即够看细节）
  imgMinScale = Math.min(ZOOM_CFG.min, imgScale * 0.5);
  imgMaxScale = Math.min(ZOOM_CFG.max, Math.max(1, imgScale * 8));
  sizeStage();
  imgX = 0; imgY = 0;
  imgClamp(); imgApply();
}
function imgClamp() {
  if (!imgStage || !imgContent) return;
  const sw = imgStage.clientWidth, sh = imgStage.clientHeight;
  // 用 img 本身的布局尺寸（zcontent 是块级元素，宽度恒等于 stage 宽，
  // 超出部分的图片内容不计入，用它会算错居中/夹边位置）
  const el = imgContent.querySelector('img') || imgContent;
  const cw = el.offsetWidth * imgScale, ch = el.offsetHeight * imgScale;
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
  // 大图（印刷级 JPG 动辄几十 MB）下载 + 解码可能十几秒，期间一片空白像"打不开"——给明确占位反馈
  const ph = document.createElement('div');
  ph.className = 'img-loading';
  ph.innerHTML = '<div class="spin"></div><div class="ltxt">图片加载中…大文件可能需要十几秒</div>';
  imgStage.appendChild(ph);
  imgEl.addEventListener('error', () => {
    ph.classList.add('err');
    const t = ph.querySelector('.ltxt'); if (t) t.textContent = '图片加载失败';
  }, { once: true });
  // 超大图检测：移动端 GPU 单张纹理有上限（4096~16384px），超大位图超出部分不渲染
  // （表现为"图片只显示一半/大片空白"）。超限则请后端生成降采样预览并换源；已换源不再重复。
  let usingDownscaled = !!imgEl.src.startsWith('blob:');
  const maybeDownscale = async () => {
    if (usingDownscaled) return;
    const nw = imgEl.naturalWidth, nh = imgEl.naturalHeight;
    if (!nw || !nh) return;
    if (nw <= 8192 && nh <= 8192 && nw * nh <= 32e6) return;   // 安全区内，无需处理
    usingDownscaled = true;
    const tip = document.createElement('div');
    tip.className = 'img-loading';
    tip.innerHTML = '<div class="spin"></div><div class="ltxt">图片尺寸较大，正在生成适配预览…</div>';
    imgStage.appendChild(tip);
    try {
      // gen=1：显式请求生成（探针不带 gen，只查缓存，避免给普通图做无谓降采样）
      const r = await fetch('/api/preview/' + shareId + '?at=' + accessToken + '&gen=1');
      if (!r.ok) throw new Error('no_preview');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      imgEl.onload = () => { tip.remove(); imgFit(); };   // 新图解码完成后重新适配
      imgEl.src = url;
    } catch (e) {
      tip.remove();   // 生成失败：保持原图（桌面端通常能正常显示），不打断
    }
  };
  const fit = () => { ph.remove(); imgFit(); maybeDownscale(); };
  if (imgEl.complete) fit(); else imgEl.onload = fit;
  imgStage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = imgStage.getBoundingClientRect();
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    const ns = Math.min(imgMaxScale, Math.max(imgMinScale, imgScale * (e.deltaY < 0 ? ZOOM_CFG.wheelImg : 1 / ZOOM_CFG.wheelImg)));
    imgX = ox - (ox - imgX) * (ns / imgScale);
    imgY = oy - (oy - imgY) * (ns / imgScale);
    imgScale = ns; sizeStage(); imgClamp(); imgApply();
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
    if (e.touches.length === 1 && last && !imgLongMode) {
      // 长图模式下单指纵向滑动交给页面滚动，不做拖移
      imgX += e.touches[0].clientX - last.x; imgY += e.touches[0].clientY - last.y;
      last = { x: e.touches[0].clientX, y: e.touches[0].clientY }; imgClamp(); imgApply();
    } else if (e.touches.length === 2) {
      const d = touchDist(e), m = touchMid(e);
      const rect = imgStage.getBoundingClientRect();
      const ns = Math.min(imgMaxScale, Math.max(imgMinScale, imgScale * (d / (pinchD || d))));
      const ox = m.x - rect.left, oy = m.y - rect.top;
      imgX = ox - (ox - imgX) * (ns / imgScale);
      imgY = oy - (oy - imgY) * (ns / imgScale);
      imgScale = ns; pinchD = d; sizeStage(); imgClamp(); imgApply();
    }
  }, { passive: false });
  imgStage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchD = 0;
    if (e.touches.length === 1) last = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  });
  imgStage.addEventListener('dblclick', () => imgSetScale(imgScale > 1.05 ? 1 : ZOOM_CFG.dblClickToggle));
  // 转屏/改窗口尺寸后重新适配窗口（手机横竖切换常见），保持图片始终可见
  window.addEventListener('resize', () => { if (zoomMode === 'image' && imgStage && imgStage.isConnected) imgFit(); });
}
function touchDist(e) { const a = e.touches[0], b = e.touches[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
function touchMid(e) { const a = e.touches[0], b = e.touches[1]; return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }

(async () => {
  try {
    if (!shareId) { $('#gateIcon').textContent = '⚠️'; $('#gateTitle').textContent = '缺少参数'; showGate('<p class="sub">无效的分享链接</p>'); return; }
    const meta = await loadMeta();
    if (!meta) return;
    $('#gateTitle').textContent = (brandName || '安阅') + ' · 安全预览';
    // 按钮文案必须跟验证方式一致：公开分享不能显示「申请打开」（访客会以为还要等授权，
    // 实际点一下就直接进）。公开/仅访问码的用中性文案。
    const cta = meta.requiresCode ? '输入访问码打开'
      : meta.authMode === 'approve' ? '申请打开'
      : meta.authMode === 'wechat' ? '微信扫码验证'
      : '打开文档';
    showGate('<p class="sub" style="text-align:center;margin-bottom:12px">' + escapeHtml(docName) + '</p><button class="btn" style="width:100%" id="openBtn">' + cta + '</button>');
    $('#openBtn').onclick = () => requestAccess();
  } catch (e) {
    // 兜底：任何未捕获异常都不再让页面停在"正在准备…"，把原因显示出来便于排查
    $('#gateIcon').textContent = '⚠️';
    $('#gateTitle').textContent = '无法打开';
    showGate('<p class="sub" style="text-align:center">' + ((e && e.message) || '页面初始化异常') + '</p>');
  }
})();
