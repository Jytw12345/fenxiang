'use strict';
// 设计源文件预览转换调度层。
// 策略：
//  - PSD/PSB/TIFF 用 Python（psd_tools + PIL）栅格化（沙箱/无外部依赖即可工作）。
//  - AI/CDR/EPS/SVG 等向量源优先用 Inkscape，其次 ImageMagick，再次 Ghostscript。
//  - 任何后端缺失或转换失败都优雅降级为「仅下载」，绝不阻断上传主流程。
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// 视为「源文件」、尝试生成预览的扩展名
const SOURCE_EXTS = ['.psd', '.psb', '.ai', '.cdr', '.eps', '.indd', '.tif', '.tiff', '.svg', '.raw', '.cr2', '.nef', '.arw', '.webp'];

const PREVIEW_TIMEOUT = Number(process.env.PREVIEW_TIMEOUT_MS) || 60000;
const SLIDE_TIMEOUT = Number(process.env.SLIDE_TIMEOUT_MS) || 180000;   // PPT 转换较慢，放宽到 3 分钟

let _pyPsd = undefined; // 能 import psd_tools 的 python 解释器路径
let _tools = undefined;  // 外部向量转换工具路径

// 探测一个 python 解释器是否可用且装了 psd_tools
function pythonHasPsd(py) {
  try {
    execSync(`"${py}" -c "import psd_tools, PIL"`, { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch (e) { return false; }
}

function defaultManagedPython() {
  // WorkBuddy managed venv 的默认路径：跨平台
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(home, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
  }
  return path.join(home, '.workbuddy', 'binaries', 'python', 'envs', 'default', 'bin', 'python');
}

// 在 PATH 中查找可执行文件。
// 注意：先走纯 Node 的 PATH 扫描，不依赖外部命令——精简镜像（debian-slim）里 which 不一定有，
// 而旧实现用的 `where ... 2>nul` 是 Windows 命令，在 Linux 上必然失败，导致容器里明明装了
// soffice/inkscape 也探测不到（表现为 PPT 预览误报「服务器未安装转换组件」）。
function locateOnPath(name) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const dirs = String(process.env.PATH || '').split(isWin ? ';' : ':');
  for (const dir of dirs) {
    const d = dir.replace(/^"|"$/g, '');
    if (!d) continue;
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (e) {}
    }
  }
  // 兜底：系统查找命令（PATH 之外或 shim 场景）
  try {
    const cmd = isWin ? `where ${name} 2>nul` : `which ${name} 2>/dev/null`;
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 })
      .toString().trim().split(/\r?\n/)[0];
    return (out && fs.existsSync(out)) ? out : null;
  } catch (e) { return null; }
}

// 返回第一个存在的绝对路径（常见安装位置兜底）
function firstExisting(list) {
  for (const p of list) { try { if (p && fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}

function detectPython() {
  if (_pyPsd !== undefined) return _pyPsd;
  const candidates = [];
  if (config.PYTHON_PATH) candidates.push(config.PYTHON_PATH);
  // 当前用户的 managed venv（自动适配用户名与平台）
  candidates.push(defaultManagedPython());
  // PATH 兜底
  candidates.push('python', 'python3');
  for (const c of candidates) {
    let exe = null;
    if (fs.existsSync(c)) exe = c;
    else exe = locateOnPath(c);
    if (exe && pythonHasPsd(exe)) { _pyPsd = exe; return _pyPsd; }
  }
  _pyPsd = null;
  return _pyPsd;
}

function detectTools() {
  if (_tools) return _tools;
  _tools = {
    magick: locateOnPath('magick'),                             // ImageMagick 7（切勿用 convert，Windows 下是磁盘工具）
    gs: locateOnPath('gswin64c') || locateOnPath('gs'),         // Ghostscript
    inkscape: locateOnPath('inkscape'),                         // Inkscape（libcdr/librsvg）
    // LibreOffice（兜底，适合 office/向量转图）；再兜常见安装位置，防 PATH 未包含
    soffice: locateOnPath('soffice') || locateOnPath('libreoffice') || firstExisting([
      '/usr/bin/soffice', '/usr/local/bin/soffice', '/usr/lib/libreoffice/program/soffice',
      '/opt/libreoffice/program/soffice',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    ])
  };
  return _tools;
}

// 带超时的子进程运行，避免在缺失/卡死的后端上无限等待
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; resolve(code); } };
    let proc;
    try { proc = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { return finish(-1); }
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} finish(-2); }, timeout);
    proc.on('error', () => finish(-1));
    proc.on('close', (code) => { clearTimeout(t); finish(code === null ? -1 : code); });
  });
}

// 生成预览：成功返回 { ok:true, buffer, format:'png' }；否则 { ok:false, reason }
async function generatePreview(ext, mime, buf) {
  if (config.PREVIEW_ENABLED === false) return { ok: false, reason: 'disabled' };
  ext = (ext || '').toLowerCase();
  if (!SOURCE_EXTS.includes(ext)) return { ok: false, reason: 'unsupported_ext' };

  const tmp = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inPath = path.join(tmp, `pv_in_${id}${ext}`);
  const outPath = path.join(tmp, `pv_out_${id}.png`);
  try {
    fs.writeFileSync(inPath, buf);
    let code = -1;

    if (['.psd', '.psb', '.tif', '.tiff'].includes(ext)) {
      const py = detectPython();
      if (py) code = await run(py, [path.join(__dirname, 'preview_worker.py'), inPath, outPath], PREVIEW_TIMEOUT);
    } else {
      // 向量/其它源：优先 Inkscape，其次 ImageMagick，再次 Ghostscript
      const tools = detectTools();
      if (ext === '.ai' || ext === '.cdr' || ext === '.svg') {
        if (tools.inkscape) code = await run(tools.inkscape, [inPath, '--export-type=png', '-o', outPath], PREVIEW_TIMEOUT);
        else if (tools.magick) code = await run(tools.magick, [inPath, outPath], PREVIEW_TIMEOUT);
        else if (tools.soffice) code = await run(tools.soffice, ['--headless', '--convert-to', 'png', '--outdir', tmp, inPath], PREVIEW_TIMEOUT);
      } else if (ext === '.eps') {
        if (tools.gs) code = await run(tools.gs, ['-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', '-sOutputFile=' + outPath, inPath], PREVIEW_TIMEOUT);
        else if (tools.magick) code = await run(tools.magick, ['eps:' + inPath, outPath], PREVIEW_TIMEOUT);
        else if (tools.inkscape) code = await run(tools.inkscape, [inPath, '--export-type=png', '-o', outPath], PREVIEW_TIMEOUT);
      }
    }

    if (code === 0 && fs.existsSync(outPath)) {
      return { ok: true, buffer: fs.readFileSync(outPath), format: 'png' };
    }
    return { ok: false, reason: 'no_backend_or_failed' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message) };
  } finally {
    try { fs.unlinkSync(inPath); } catch (e) {}
    try { fs.unlinkSync(outPath); } catch (e) {}
  }
}

// PPT → PDF：用 LibreOffice headless 转换，供幻灯片按 PDF 查看器打开（复用缩放/拖移/试看/水印全套能力）
// 成功返回 { ok:true, buffer, format:'pdf' }；soffice 缺失或失败返回 { ok:false, reason }
async function generateSlidePdf(ext, buf) {
  if (config.PREVIEW_ENABLED === false) return { ok: false, reason: 'disabled' };
  ext = (ext || '').toLowerCase();
  if (!['.pptx', '.ppt'].includes(ext)) return { ok: false, reason: 'unsupported_ext' };
  const tools = detectTools();
  if (!tools.soffice) return { ok: false, reason: 'no_soffice' };   // 前端据此提示"可下载查看"

  const tmp = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inPath = path.join(tmp, `slide_in_${id}${ext}`);
  // 每次转换用独立的 LibreOffice 用户配置目录：容器内 HOME 可能不可写，且并发调用共用
  // 同一 profile 时第二个实例会因 profile 锁直接失败。
  const profile = path.join(tmp, `lo_profile_${id}`);
  try {
    fs.writeFileSync(inPath, buf);
    // soffice 输出文件名 = 输入文件名换 .pdf（--outdir 控制目录）
    const code = await run(tools.soffice, [
      '--headless', '--norestore', '--nologo', '--nolockcheck',
      '-env:UserInstallation=file://' + profile,
      '--convert-to', 'pdf', '--outdir', tmp, inPath
    ], SLIDE_TIMEOUT);
    const outPath = inPath.slice(0, -ext.length) + '.pdf';
    if (code === 0 && fs.existsSync(outPath)) {
      const out = fs.readFileSync(outPath);
      try { fs.unlinkSync(outPath); } catch (e) {}
      return { ok: true, buffer: out, format: 'pdf' };
    }
    return { ok: false, reason: code === -2 ? 'timeout' : 'no_backend_or_failed' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message) };
  } finally {
    try { fs.unlinkSync(inPath); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}

// 超大图片降采样：移动端 GPU 单张纹理有上限（常见 4096~16384px），超大位图超出部分直接
// 不渲染（表现为"图片只显示一半/大片空白"）。生成一张长边 ≤ maxSide 的 JPEG 给查看器用，
// 原文件下载不受影响。成功返回 { ok:true, buffer, format:'jpg' }。
const IMAGE_DOWNSCALE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
async function generateImageDownscale(ext, buf, maxSide) {
  if (config.PREVIEW_ENABLED === false) return { ok: false, reason: 'disabled' };
  ext = (ext || '').toLowerCase();
  if (!IMAGE_DOWNSCALE_EXTS.includes(ext)) return { ok: false, reason: 'unsupported_ext' };
  const py = detectPython();
  if (!py) return { ok: false, reason: 'no_python' };

  const tmp = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inPath = path.join(tmp, `imgds_in_${id}${ext}`);
  const outPath = path.join(tmp, `imgds_out_${id}.jpg`);
  try {
    fs.writeFileSync(inPath, buf);
    const env = Object.assign({}, process.env, { PREVIEW_MAX_DIM: String(maxSide || 4096) });
    const code = await new Promise((resolve) => {
      let done = false, proc;
      const finish = (c) => { if (!done) { done = true; resolve(c); } };
      try { proc = spawn(py, [path.join(__dirname, 'preview_worker.py'), inPath, outPath], { windowsHide: true, env }); }
      catch (e) { return finish(-1); }
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} finish(-2); }, PREVIEW_TIMEOUT);
      proc.on('error', () => finish(-1));
      proc.on('close', (c) => { clearTimeout(t); finish(c === null ? -1 : c); });
    });
    if (code === 0 && fs.existsSync(outPath)) {
      return { ok: true, buffer: fs.readFileSync(outPath), format: 'jpg' };
    }
    return { ok: false, reason: 'no_backend_or_failed' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message) };
  } finally {
    try { fs.unlinkSync(inPath); } catch (e) {}
    try { fs.unlinkSync(outPath); } catch (e) {}
  }
}

module.exports = { generatePreview, generateSlidePdf, generateImageDownscale, SOURCE_EXTS, detectPython, detectTools };
