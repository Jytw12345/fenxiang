'use strict';
// 统一存储抽象层：默认本地磁盘；配置腾讯云 COS 后自动切换，无凭证/SDK 缺失时回退本地。
const fs = require('fs');
const path = require('path');
const config = require('./config');

const UPLOAD_DIR = config.UPLOAD_DIR;
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let cos = null;
if (config.COS.enabled) {
  try {
    const COS = require('cos-nodejs-sdk-v5');
    cos = new COS({ SecretId: config.COS.SecretId, SecretKey: config.COS.SecretKey });
    console.log('[storage] 已启用腾讯云 COS 存储');
  } catch (e) {
    console.warn('[storage] 检测到 COS 配置但 cos-nodejs-sdk-v5 未安装，回退本地磁盘：', e.message);
  }
} else {
  console.log('[storage] 使用本地磁盘存储（配置 COS_* 环境变量可切换到对象存储）');
}

const cosKey = (storedName) => 'uploads/' + storedName;

// 保存：storedName 为逻辑文件名，buffer 为内容，mime 为类型
async function save(storedName, buffer, mime) {
  if (cos) {
    try {
      await new Promise((resolve, reject) => {
        cos.putObject({
          Bucket: config.COS.Bucket, Region: config.COS.Region,
          Key: cosKey(storedName), Body: buffer, ContentType: mime || 'application/octet-stream'
        }, (err, data) => err ? reject(err) : resolve(data));
      });
      return;
    } catch (e) {
      // 把 COS 关键错误码/状态码打到服务端日志，便于在 Render 后台直接看到根因
      console.error('[storage] COS 上传失败：', {
        bucket: config.COS.Bucket, region: config.COS.Region, key: cosKey(storedName),
        code: e.code, statusCode: e.statusCode, message: e.message
      });
      throw new Error('COS 上传失败（' + (e.code || e.statusCode || e.message || '未知错误') +
        '）：请检查 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION 是否正确，' +
        '且该密钥对桶 ' + config.COS.Bucket + ' 拥有写入权限');
    }
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);
}

// 读取为 Buffer（pdf/image/docx 共用）
async function readBuffer(storedName) {
  if (cos) {
    const data = await new Promise((resolve, reject) => {
      cos.getObject({ Bucket: config.COS.Bucket, Region: config.COS.Region, Key: cosKey(storedName) },
        (err, d) => err ? reject(err) : resolve(d));
    });
    return Buffer.from(data.Body);
  }
  return fs.readFileSync(path.join(UPLOAD_DIR, storedName));
}

// 文件总字节数（用于 Range 响应中的 Content-Range 分母）
async function fileSize(storedName) {
  if (cos) {
    const data = await new Promise((resolve, reject) => {
      cos.headObject({ Bucket: config.COS.Bucket, Region: config.COS.Region, Key: cosKey(storedName) },
        (err, d) => err ? reject(err) : resolve(d));
    });
    return Number(data.headers['content-length']) || 0;
  }
  try { return fs.statSync(path.join(UPLOAD_DIR, storedName)).size; } catch (e) { return 0; }
}

// 区间读取（支持 HTTP Range / 断点续传 / pdf.js 按需分页）。返回 { buffer, total }
async function readRange(storedName, start, end) {
  if (cos) {
    const data = await new Promise((resolve, reject) => {
      cos.getObject({
        Bucket: config.COS.Bucket, Region: config.COS.Region, Key: cosKey(storedName),
        Range: `bytes=${start}-${end}`
      }, (err, d) => err ? reject(err) : resolve(d));
    });
    // COS 在 Range 请求下返回 content-range 头，形如 bytes 0-1023/5678
    const cr = data.headers && data.headers['content-range'];
    const total = cr ? Number(cr.split('/')[1]) : (Number(data.headers['content-length']) || 0);
    return { buffer: Buffer.from(data.Body), total };
  }
  const fp = path.join(UPLOAD_DIR, storedName);
  const total = fs.statSync(fp).size;
  const fd = fs.openSync(fp, 'r');
  const len = Math.min(end, total - 1) - start + 1;
  const buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  return { buffer: buf, total };
}

// 公开访问 URL：仅当配置了 COS_BASE_URL 才返回；默认返回 null（内容走服务端鉴权下发，更安全）
function publicUrl(storedName) {
  if (cos && config.COS.BaseUrl) {
    const base = config.COS.BaseUrl.replace(/\/$/, '');
    return `${base}/${cosKey(storedName)}`;
  }
  return null;
}

// 预签名直连 URL：用于 /api/content、/api/preview 在 COS 模式下 302 跳转，
// 让客户端绕过 Render 直接拉取对象，从而把文件字节流量从 Render 出带宽转移到 COS 外网下行。
// 每次请求都会重新走服务端会话校验，并签发一个短时效（config.COS.SignExpires）的签名 URL，
// 因此在有效期窗口内即使泄漏也仅能被滥用极短时间；配合 COS 桶 Referer 防盗链可进一步收敛。
// opts.disposition：强制下载时的 Content-Disposition（如 'attachment; filename="x.pdf"'）
// opts.contentType：强制响应 Content-Type（如 PDF 在线预览需 'application/pdf'）
async function getSignedUrl(storedName, opts = {}) {
  if (!cos) return null;
  const expires = opts.expires || config.COS.SignExpires || 300;
  const Query = {};
  if (opts.disposition) Query['response-content-disposition'] = opts.disposition;
  if (opts.contentType) Query['response-content-type'] = opts.contentType;
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({
      Bucket: config.COS.Bucket, Region: config.COS.Region,
      Key: cosKey(storedName),
      Sign: true, Expires: expires, Query
    }, (err, data) => {
      if (err) return reject(err);
      resolve(data.Url);
    });
  });
}

// 删除：用于清理已销毁分享的文件、删除用户时释放空间
async function del(storedName) {
  if (cos) {
    await new Promise((resolve, reject) => {
      cos.deleteObject({
        Bucket: config.COS.Bucket, Region: config.COS.Region, Key: cosKey(storedName)
      }, (err) => err ? reject(err) : resolve());
    });
    return;
  }
  const fp = path.join(UPLOAD_DIR, storedName);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

module.exports = { save, readBuffer, readRange, fileSize, publicUrl, getSignedUrl, delete: del, cosEnabled: !!cos, UPLOAD_DIR };
