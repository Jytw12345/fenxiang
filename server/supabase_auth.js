'use strict';
// Supabase 令牌校验：采用「服务端向 Supabase 自身求证」方式，零外部依赖（仅用 Node 内置 https）。
// 不再在后端用 JWT_SECRET 做本地 HMAC 校验——那样要求前后端密钥字节级一致，极易因密钥被轮换 /
// 复制带入空格等原因导致永远 invalid_token。改为：后端拿着用户令牌去问 Supabase 的
// GET /auth/v1/user 端点（携带公开的 anon key），Supabase 服务端校验令牌有效性并返回用户，
// 这样只要前端能登录成功，后端就一定能认，彻底消除密钥同步问题。
const https = require('https');
const config = require('./config');

function getJson(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      headers
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs || 8000, () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}

// 校验 Supabase 签发的 JWT：返回 { sub, email, raw } 或 null（无效/过期/网络异常/未启用）。
async function verifySupabaseToken(token) {
  if (!config.SUPABASE.enabled) return null;
  if (!token || typeof token !== 'string') return null;
  const base = config.SUPABASE.URL.replace(/\/+$/, '');
  const anon = config.SUPABASE.ANON_KEY;
  if (!base || !anon) return null;

  const data = await getJson(`${base}/auth/v1/user`, {
    'Authorization': `Bearer ${token}`,
    'apikey': anon,
    'Content-Type': 'application/json'
  }, 8000);

  if (!data) return null;
  // Supabase 返回形如 { "id": "...", "email": "...", "aud": "authenticated", ... }
  // 某些版本包在 { user: {...} } 中，做兼容。
  const user = data.user || data;
  if (!user || !user.id) return null;
  return {
    sub: user.id,
    email: user.email || '',
    raw: user
  };
}

module.exports = { verifySupabaseToken };
