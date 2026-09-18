'use strict';
// 零依赖工具：User-Agent 解析 + IP 地理归属（内网同步判断，公网异步查询并降级）

// ---------- UA 解析（设备 / 系统 / 浏览器） ----------
function parseUa(ua) {
  ua = String(ua || '');
  let device = '桌面', os = '未知', browser = '未知';
  if (/(iphone|ipod)/i.test(ua)) os = 'iOS';
  else if (/ipad/i.test(ua)) os = 'iOS';
  else if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/linux/i.test(ua)) os = 'Linux';
  else if (/harmonyos|hongmeng/i.test(ua)) os = 'HarmonyOS';

  if (/ipad/i.test(ua)) device = '平板';
  else if (/(android.*mobile)|(iphone)|(ipod)/i.test(ua)) device = '手机';
  else if (/tablet/i.test(ua)) device = '平板';

  if (/micromessenger/i.test(ua)) browser = '微信内置';
  else if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) browser = 'Chrome';
  else if (/safari\//i.test(ua) && /version\//i.test(ua)) browser = 'Safari';
  else if (/qqbrowser/i.test(ua)) browser = 'QQ浏览器';
  else if (/ucbrowser/i.test(ua)) browser = 'UC浏览器';
  else if (/baidubrowser|baiduboxapp/i.test(ua)) browser = '百度浏览器';
  else if (/weibo/i.test(ua)) browser = '微博';
  return { device, os, browser };
}

// ---------- IP 是否为内网/保留段 ----------
function isPrivateIp(ip) {
  if (!ip) return true;
  if (/^(::1|127\.|fe80:|fc|fd)/i.test(ip)) return true;
  if (/^(10\.|192\.168\.|169\.254\.)/.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  // IPv6 映射地址
  if (ip.indexOf('.') === -1) return false; // 其他 IPv6 视为公网
  return false;
}

// ---------- IP 地理（ip2region 离线中文库：国内精确到市/运营商，毫秒级零网络依赖） ----------
// 失败时降级到 ipwho.is 在线查询；再失败为空。不阻塞主流程。
let _ip2r = null;
function getIp2r() {
  if (_ip2r !== null) return _ip2r;
  try {
    const mod = require('ip2region');
    _ip2r = new (mod.default || mod)();
  } catch (e) { _ip2r = false; }
  return _ip2r;
}
async function geoIp(ip) {
  const none = { country: '', region: '', city: '' };
  if (!ip || isPrivateIp(ip)) return { country: '内网/局域网', region: '', city: '' };
  const r = getIp2r();
  if (r) {
    try {
      const d = r.search(ip);
      if (d && d.country) {
        return {
          country: d.country,
          region: [d.province, d.city].filter(Boolean).join('·'),
          city: d.isp || ''
        };
      }
    } catch (e) { /* 落到在线查询 */ }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const r2 = await fetch('https://ipwho.is/' + encodeURIComponent(ip), { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r2.json();
    if (j && j.success && (j.country || j.city)) {
      return { country: j.country || '', region: j.region || '', city: j.city || '' };
    }
  } catch (e) { /* 降级为空，不抛错 */ }
  return none;
}

module.exports = { parseUa, isPrivateIp, geoIp };
