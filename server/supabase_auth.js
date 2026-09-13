'use strict';
// 轻量 Supabase JWT 校验（HS256），零外部依赖，仅用 Node 内置 crypto。
// Supabase 用户令牌与 anon key 均由项目 JWT Secret 以 HS256 签名。
const crypto = require('crypto');
const config = require('./config');

function b64urlDecode(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4;
  if (pad) t += '='.repeat(4 - pad);
  return Buffer.from(t, 'base64');
}

// 校验 Supabase 签发的 JWT，返回 payload（含 sub/email）或 null（无效/过期/未启用）。
// Supabase 后台的 JWT Secret 通常以 base64 形式展示（底层是 64 字节随机密钥），
// 因此优先尝试用 base64 解码后的字节作为 HMAC key；失败时再回退原始字符串。
function resolveJwtSecret(raw) {
  if (!raw) return raw;
  try {
    const buf = Buffer.from(raw, 'base64');
    // 仅当解码后长度合理（>=32 字节）且可往返时，才视为 base64 编码的密钥
    if (buf.length >= 32 && buf.toString('base64') === raw) return buf;
  } catch (e) { /* ignore */ }
  return raw;
}

function verifyTokenWithSecret(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header;
  try { header = JSON.parse(b64urlDecode(h).toString('utf8')); }
  catch (e) { return null; }
  if (header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(p).toString('utf8')); }
  catch (e) { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

function verifySupabaseToken(token) {
  if (!config.SUPABASE.enabled) return null;
  if (!token || typeof token !== 'string') return null;
  const secret = resolveJwtSecret(config.SUPABASE.JWT_SECRET);
  // 先用解析后的密钥（base64 解码后的字节），失败再回退原始字符串
  return verifyTokenWithSecret(token, secret) || verifyTokenWithSecret(token, config.SUPABASE.JWT_SECRET);
}

module.exports = { verifySupabaseToken };
