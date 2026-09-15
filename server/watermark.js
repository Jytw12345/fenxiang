'use strict';
// 后端水印引擎：为「下载带水印」生成带水印的副本。
// 设计为「尽力而为」：任何步骤失败都返回 null，调用方应回退为下发原文件，绝不阻断下载。
const fs = require('fs');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

// 候选中文字体（TTF/OTF）。优先使用运行环境已有的系统字体，避免向仓库塞入大体积字体文件。
// 部署到 Linux 时请确认其中一路径存在（如 Noto / WenQuanYi），否则 PDF 水印会回退为仅拉丁字符。
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simsun.ttc',
  'C:/Windows/Fonts/simfang.ttf',
  'C:/Windows/Fonts/msyhl.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/Library/Fonts/Arial Unicode.ttf'
];
let _fontBytes = null, _fontPath = null, _fontTried = false;
function getFont() {
  if (_fontTried) return _fontBytes ? { path: _fontPath, bytes: _fontBytes } : null;
  _fontTried = true;
  for (const f of FONT_CANDIDATES) {
    try { if (fs.existsSync(f)) { _fontPath = f; _fontBytes = fs.readFileSync(f); return { path: _fontPath, bytes: _fontBytes }; } } catch (e) {}
  }
  return null;
}
function getFontBytes() { const f = getFont(); return f ? f.bytes : null; }
function getFontPath() { const f = getFont(); return f ? f.path : null; }

// fontkit 注册是 instance 方法（pdfDoc.registerFontkit），不是静态方法。
// 优先使用 @pdf-lib/fontkit（pdf-lib 官方配套的纯 JS 构建，API 与 1.17.1 的 subset 兼容）；
// 若只装了 fontkit 2.x 会因 subset.encodeStream 缺失而失败，故这里只认官方配套包。
let _fontkit = null, _fontkitTried = false;
function getFontkit() {
  if (_fontkitTried) return _fontkit;
  _fontkitTried = true;
  try {
    const m = require('@pdf-lib/fontkit');
    _fontkit = (m && m.default) ? m.default : m; // 兼容 default 导出
  } catch (e) { _fontkit = null; }
  return _fontkit;
}

// 把水印设置 + 上下文转成要印的文字。下载副本是静态快照：动态水印在此落定为「文字 + 访客ID + 时间」。
function wmText(wm, opts) {
  opts = opts || {};
  const base = (wm && wm.text) ? wm.text : '内部资料 严禁外传';
  let s = base;
  if (opts.viewerId) s += '  ' + opts.viewerId;
  if (opts.time) s += '  ' + opts.time;
  return s;
}

// ---------- PDF ----------
async function watermarkPdf(buf, wm, opts) {
  const pdf = await PDFDocument.load(buf);
  const fontBytes = getFontBytes();
  let font = null;
  const fk = getFontkit();
  if (fontBytes && fk) {
    try {
      pdf.registerFontkit(fk); // instance 方法
      font = await pdf.embedFont(fontBytes, { subset: true });
    } catch (e) { font = null; }
  }
  if (!font) font = await pdf.embedFont(StandardFonts.Helvetica); // 回退：仅支持拉丁字符
  const txt = wmText(wm, opts);
  const size = 22, opacity = 0.16, stepX = 240, stepY = 150, rot = degrees(28);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    for (let y = -height; y < height * 2; y += stepY) {
      for (let x = -width; x < width * 2; x += stepX) {
        try {
          page.drawText(txt, { x, y, size, font, color: rgb(0, 0, 0), opacity, rotate: rot });
        } catch (e) { /* 个别字符无法编码时跳过该格 */ }
      }
    }
  }
  const out = await pdf.save();
  return { buf: Buffer.from(out), mime: 'application/pdf', ext: 'pdf' };
}

// ---------- 图片 ----------
async function watermarkImage(buf, mime, wm, opts) {
  // 优先 pureimage（纯 JS，支持 TTF / 中文）
  try {
    const pureimage = require('pureimage');
    const { Readable, Writable } = require('stream');
    const fontPath = getFontPath();
    if (!fontPath) throw new Error('no-cjk-font');
    let img, isPng;
    if (mime && (mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0)) {
      img = await pureimage.decodeJPEGFromStream(Readable.from(buf)); isPng = false;
    } else if (mime && mime.indexOf('gif') >= 0) {
      throw new Error('gif-unsupported');
    } else {
      img = await pureimage.decodePNGFromStream(Readable.from(buf)); isPng = true;
    }
    const font = pureimage.registerFont(fontPath, 'wmfont');
    await font.load(); // pureimage: load() 返回 Promise，需 await
    const ctx = img.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    const txt = wmText(wm, opts);
    const w = img.width, h = img.height;
    const size = Math.max(16, Math.round(Math.min(w, h) / 28));
    ctx.save();
    ctx.font = size + 'px wmfont';
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 6);
    ctx.translate(-w / 2, -h / 2);
    let yy = -h;
    const stepX = Math.max(140, size * 11), stepY = Math.max(90, size * 6);
    while (yy < h * 2) {
      let xx = -w;
      while (xx < w * 2) { ctx.fillText(txt, xx, yy); xx += stepX; }
      yy += stepY;
    }
    ctx.restore();
    const chunks = [];
    await new Promise((resolve, reject) => {
      const out = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
      const enc = isPng ? pureimage.encodePNGToStream : pureimage.encodeJPEGToStream;
      enc(img, out).then(resolve).catch(reject);
    });
    const outBuf = Buffer.concat(chunks);
    const outMime = isPng ? 'image/png' : 'image/jpeg';
    return { buf: outBuf, mime: outMime, ext: isPng ? 'png' : 'jpg' };
  } catch (e) {
    return null; // 图片水印失败 → 调用方回退原文件
  }
}

// 统一入口。返回 {buf,mime,ext} 或 null（失败/不支持）。
async function watermarkFile(buf, kind, mime, wm, opts) {
  if (!wm || wm.mode === 'none') return null;
  try {
    if (kind === 'pdf') return await watermarkPdf(buf, wm, opts);
    if (kind === 'image') return await watermarkImage(buf, mime, wm, opts);
  } catch (e) {
    return null;
  }
  return null;
}

module.exports = { watermarkFile };
