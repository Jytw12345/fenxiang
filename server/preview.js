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

function locateOnPath(name) {
  try {
    const cmd = process.platform === 'win32' ? `where ${name} 2>nul` : `which ${name} 2>/dev/null`;
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 })
      .toString().trim().split(/\r?\n/)[0];
    return (out && fs.existsSync(out)) ? out : null;
  } catch (e) { return null; }
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
  const detect = (c) => {
    try {
      const out = execSync(`where ${c} 2>nul`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 })
        .toString().trim().split(/\r?\n/)[0];
      return (out && fs.existsSync(out)) ? out : null;
    } catch (e) { return null; }
  };
  _tools = {
    magick: detect('magick'),                                   // ImageMagick 7（切勿用 convert，Windows 下是磁盘工具）
    gs: detect('gswin64c') || detect('gs'),                     // Ghostscript
    inkscape: detect('inkscape'),                               // Inkscape（libcdr/librsvg）
    soffice: detect('soffice') || detect('libreoffice')         // LibreOffice（兜底，适合 office/向量转图）
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

module.exports = { generatePreview, SOURCE_EXTS };
