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
    await new Promise((resolve, reject) => {
      cos.putObject({
        Bucket: config.COS.Bucket, Region: config.COS.Region,
        Key: cosKey(storedName), Body: buffer, ContentType: mime || 'application/octet-stream'
      }, (err, data) => err ? reject(err) : resolve(data));
    });
    return;
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

// 公开访问 URL：仅当配置了 COS_BASE_URL 才返回；默认返回 null（内容走服务端鉴权下发，更安全）
function publicUrl(storedName) {
  if (cos && config.COS.BaseUrl) {
    const base = config.COS.BaseUrl.replace(/\/$/, '');
    return `${base}/${cosKey(storedName)}`;
  }
  return null;
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

module.exports = { save, readBuffer, publicUrl, delete: del, cosEnabled: !!cos, UPLOAD_DIR };
