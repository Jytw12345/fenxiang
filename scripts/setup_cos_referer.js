'use strict';
// COS Referer 防盗链一键配置 + 自测脚本
//
// 作用：直连模式下 /api/content、/api/preview 返回 302 跳转到 COS 预签名 URL，
//       文件由客户端直拉 COS。若不开 Referer 防盗链，签名 URL 一旦外泄会被白嫖流量。
//       本脚本用 SDK 把桶设为「Referer 白名单」，并自动上传探针文件验证黑白请求是否被正确放行/拒绝。
//
// 用法（在已 npm install 且装了 cos-nodejs-sdk-v5 的环境下）：
//   配置：  COS_SECRET_ID=xxx COS_SECRET_KEY=yyy COS_BUCKET=share-1250000000 COS_REGION=ap-guangzhou \
//           ALLOWED_REFERER="https://share.example.com,*.example.com" EMPTY_REFERER=Deny \
//           node scripts/setup_cos_referer.js set
//   验证：  COS_SECRET_ID=xxx COS_SECRET_KEY=yyy COS_BUCKET=share-1250000000 COS_REGION=ap-guangzhou \
//           node scripts/setup_cos_referer.js verify
//
// 说明：
//   ALLOWED_REFERER  允许的来源域名，逗号分隔，支持 *.example.com 通配；至少填你的站点域名
//   EMPTY_REFERER    Deny=拒绝空 Referer（粘贴签名 URL 到地址栏会被拦，最安全）；
//                    Allow=允许空 Referer（若某些 PDF 预览器不发 Referer 导致看图失败，改 Allow）
const COS = require('cos-nodejs-sdk-v5');

const Bucket = process.env.COS_BUCKET;
const Region = process.env.COS_REGION;
const SecretId = process.env.COS_SECRET_ID;
const SecretKey = process.env.COS_SECRET_KEY;

function fail(msg) {
  console.error('✖ ' + msg);
  console.error('  请确认已设置环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION');
  process.exit(1);
}
if (!SecretId || !SecretKey || !Bucket || !Region) fail('缺少 COS 凭证环境变量');

const cos = new COS({ SecretId, SecretKey });
const cmd = process.argv[2];

function getCfg() {
  const domains = (process.env.ALLOWED_REFERER || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!domains.length) fail('ALLOWED_REFERER 不能为空（至少填你的站点域名，如 https://share.example.com）');
  const emptyReferer = process.env.EMPTY_REFERER === 'Allow' ? 'Allow' : 'Deny';
  return { Status: 'Enabled', RefererType: 'White-List', DomainList: { Domains: domains }, EmptyReferer: emptyReferer };
}

if (cmd === 'set') {
  const RefererConfiguration = getCfg();
  cos.putBucketReferer({ Bucket, Region, RefererConfiguration }, (err) => {
    if (err) { console.error('✖ 配置失败：', err.message || err); process.exit(1); }
    console.log('✔ 已为桶 ' + Bucket + ' 开启 Referer 白名单：');
    console.log('  域名：', RefererConfiguration.DomainList.Domains.join(', '));
    console.log('  空 Referer：', RefererConfiguration.EmptyReferer);
    console.log('  随后用 `node scripts/setup_cos_referer.js verify` 验证是否生效。');
  });
}
else if (cmd === 'verify') {
  const PROBE = 'referer-probe-' + Date.now() + '.txt';
  const probeBody = Buffer.from('referer-probe');
  const allowed = (process.env.ALLOWED_REFERER || '').split(',').map(s => s.trim()).filter(Boolean)[0] || 'https://share.example.com/';
  // 取白名单里第一个域名拼一个合法 Referer（去掉通配前缀）
  const goodReferer = allowed.replace(/^\*\./, 'https://') + (allowed.includes('://') ? '' : '/');
  const badReferer = 'https://evil.example.com/';

  (async () => {
    // 1) 上传探针
    await new Promise((res, rej) => cos.putObject({ Bucket, Region, Key: PROBE, Body: probeBody },
      (e) => e ? rej(e) : res()));
    // 2) 生成 120s 预签名 URL
    const url = await new Promise((res, rej) => cos.getObjectUrl({ Bucket, Region, Key: PROBE, Sign: true, Expires: 120 },
      (e, d) => e ? rej(e) : res(d.Url)));
    const check = async (label, referer, expectOk) => {
      const headers = referer ? { Referer: referer } : {};
      const r = await fetch(url, { headers });
      const ok = r.status === 200;
      const pass = ok === expectOk;
      console.log((pass ? '  ✔ ' : '  ✖ ') + label + ' -> HTTP ' + r.status + (pass ? '' : ' （预期 ' + (expectOk ? 200 : 403) + '）'));
      return pass;
    };
    let allPass = true;
    console.log('探针 URL：', url.slice(0, 80) + '...');
    allPass = (await check('合法 Referer（你的域名）应放行', goodReferer, true)) && allPass;
    allPass = (await check('非法 Referer（evil.example.com）应拒绝', badReferer, false)) && allPass;
    allPass = (await check('空 Referer（地址栏直开）应按桶设置拒绝', null, (process.env.EMPTY_REFERER === 'Allow'))) && allPass;
    // 3) 清理探针
    await new Promise((res) => cos.deleteObject({ Bucket, Region, Key: PROBE }, () => res()));
    console.log(allPass ? '✔ 防盗链验证通过' : '✖ 存在不符合预期的请求，请检查配置');
    process.exit(allPass ? 0 : 1);
  })().catch(e => { console.error('✖ verify 异常：', e.message || e); process.exit(1); });
}
else {
  console.log('用法：');
  console.log('  node scripts/setup_cos_referer.js set     # 按 ALLOWED_REFERER / EMPTY_REFERER 配置白名单');
  console.log('  node scripts/setup_cos_referer.js verify  # 上传探针并验证放行/拒绝是否符合预期');
  process.exit(0);
}
