'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const db = require('./db');
const config = require('./config');
const storage = require('./storage');
const preview = require('./preview');
const { verifySupabaseToken } = require('./supabase_auth');

const UPLOAD_DIR = db.UPLOAD_DIR;
const PORT = config.PORT;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB

// 支持上传的文件格式白名单（与分享内容分类一致）。其余格式在读取文件体之前即拒绝，不上传。
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_KINDS = new Set(['pdf', 'image', 'docx', 'source']);
// 用于前端提示/校验消息的可读扩展名清单
const SUPPORTED_EXTS = ['.pdf', '.docx', ...IMAGE_EXTS, ...preview.SOURCE_EXTS.filter(e => !IMAGE_EXTS.includes(e))];
const SUPPORTED_HINT = '仅支持 PDF、Word(.docx)、常见图片(PNG/JPG/JPEG/GIF/WEBP/BMP) 与设计源文件(PSD/PSB/AI/CDR/EPS/INDD/TIF/TIFF/SVG/RAW/CR2/NEF/ARW)';

// 根据扩展名 + MIME 判定分享内容类型；未知类型返回 'download'（即不在白名单内）
function classifyKind(ext, mime) {
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (IMAGE_EXTS.includes(ext) || (mime && mime.startsWith('image/'))) return 'image';
  if (ext === '.docx' || mime === DOCX_MIME) return 'docx';
  if (preview.SOURCE_EXTS.includes(ext)) return 'source';
  return 'download';
}

// 注册频率限制（进程内存计数，足以拦截自动化批量注册；服务重启清零，单机场景足够）
const regAttempts = new Map(); // key -> { count, first }
function regSweep() {
  const now = Date.now();
  for (const [k, v] of regAttempts) if (now - v.first > config.REG_WINDOW_MS) regAttempts.delete(k);
}
function regCount(key) {
  const e = regAttempts.get(key);
  if (!e || Date.now() - e.first > config.REG_WINDOW_MS) { regAttempts.set(key, { count: 0, first: Date.now() }); return 0; }
  return e.count;
}
function regHit(key) {
  const e = regAttempts.get(key);
  if (!e) regAttempts.set(key, { count: 1, first: Date.now() });
  else e.count++;
}

// ---------- 工具 ----------
function uuid() { return crypto.randomBytes(16).toString('hex'); }
function nowMs() { return Date.now(); }
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
// 跨域头：前端（GitHub Pages 等异源）调用 API 必需。无 cookie，故不开启 credentials。
function corsHeaders(req) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Credentials': 'false',
    'Vary': 'Origin'
  };
}
function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- 密码哈希（scrypt，零依赖）----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}
function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return '密码至少 8 位';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return '密码需同时包含字母和数字';
  const weak = ['12345678', 'password', 'qwerty123', '11111111', 'abcdefgh', '1234567890', 'qwertyui'];
  if (weak.includes(pw.toLowerCase())) return '密码过于常见，请更换';
  return null;
}
// 解析用户 prefs（JSON 字符串 -> 对象；异常时回退空对象）
function parsePrefs(raw) {
  if (!raw) return {};
  try { const o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
}

// ---------- 鉴权辅助 ----------
// 双模式身份解析：启用 Supabase 时校验其 JWT 并映射到本地用户；否则沿用自研 user_tokens。
async function resolveIdentity(token) {
  if (!token) return null;
  if (config.SUPABASE.enabled) {
    const payload = await verifySupabaseToken(token);
    if (!payload) return null;
    const u = await db.getUserBySupabaseId(payload.sub);
    return u ? { type: 'user', userId: u.id } : null;
  }
  const ut = await db.getUserToken(token);
  if (ut) return { type: 'user', userId: ut.userId };
  return null;
}
async function resolveOwner(token) {
  const idn = await resolveIdentity(token);
  if (idn) return idn;
  return { type: 'owner', ownerToken: token };
}
// 校验并返回店长用户对象（仅 role=admin 通过）
async function requireAdmin(token) {
  const idn = await resolveIdentity(token);
  if (!idn || idn.type !== 'user') return null;
  const u = await db.getUser(idn.userId);
  if (!u || u.role !== 'admin') return null;
  return u;
}
// 校验并返回超级管理员（is_super=1）
async function requireSuper(token) {
  const idn = await resolveIdentity(token);
  if (!idn || idn.type !== 'user') return null;
  const u = await db.getUser(idn.userId);
  if (!u || !u.is_super) return null;
  return u;
}
async function ownerShare(token, shareId) {
  const o = await resolveOwner(token);
  const s = await db.getShare(shareId);
  if (!s) return null;
  if (o.type === 'user') return s.owner_id === o.userId ? s : null;
  return s.owner_token === o.ownerToken ? s : null;
}
// 店长可管理本组织内任意分享（员工仅能管理自己的）
async function manageShare(token, shareId) {
  const o = await resolveOwner(token);
  const s = await db.getShare(shareId);
  if (!s) return null;
  if (o.type === 'user') {
    if (s.owner_id === o.userId) return s;
    const me = await db.getUser(o.userId);
    if (me && me.role === 'admin' && me.org_id && s.owner_id) {
      const owner = await db.getUser(s.owner_id);
      if (owner && owner.org_id === me.org_id) return s;
    }
    return null;
  }
  return s.owner_token === o.ownerToken ? s : null;
}
// 店长/超管均可管理：店长按组织范围，超级管理员可管理任意分享（含无归属分享）。
// 后台界面必须登录后才能操作，不再接受匿名 ownerToken。
async function resolveShareForAdmin(token, shareId) {
  const idn = await resolveIdentity(token);
  if (!idn || idn.type !== 'user') return null;
  const s = await db.getShare(shareId);
  if (!s) return null;
  // 自己创建的分享
  if (s.owner_id === idn.userId) return s;
  // 店长管理本组织成员创建的分享
  const u = await db.getUser(idn.userId);
  if (u && u.role === 'admin' && u.org_id && s.owner_id) {
    const owner = await db.getUser(s.owner_id);
    if (owner && owner.org_id === u.org_id) return s;
  }
  // 超级管理员可管理任意分享
  const sup = await requireSuper(token);
  if (sup) return s;
  return null;
}
// 解析新用户应归属的门店与角色。
// 门店(org)由超级管理员在后台统一创建与分配；普通注册仅能凭有效邀请码加入指定门店，
// 否则 org_id 为空（未入店），创建分享时将被网关拦截。
async function resolveOrg(email, inviteCode) {
  if (inviteCode) {
    const inv = await db.getInvite(inviteCode);
    if (!inv) return { error: 'invalid_invite', message: '邀请码无效' };
    return { orgId: inv.org_id, role: 'member' };
  }
  // 无邀请码：默认不归属任何门店（待超管在后台分配）
  return { orgId: '', role: 'member' };
}

// ---------- 授权会话发放 ----------
async function grantAccess(req, share, viewerToken) {
  const token = uuid();
  const ttl = (share.duration_sec > 0 ? share.duration_sec : 24 * 3600) * 1000;
  // 若分享设有「预览后需密码」，新建会话默认为未解锁；否则直接解锁
  let extraObj = {};
  try { extraObj = share.extra ? JSON.parse(share.extra) : {}; } catch (e) { extraObj = {}; }
  const needUnlock = !!(extraObj.previewPages && extraObj.protectPassword);
  await db.createSession({ token, shareId: share.id, viewerToken, expiresAt: nowMs() + ttl, unlocked: needUnlock ? 0 : 1 });
  const ip = req ? clientIp(req) : '';
  const ua = req ? (req.headers['user-agent'] || '') : '';
  await db.logOpen({ shareId: share.id, viewerToken, ip, ua, now: nowMs() });
  return {
    ok: true, accessToken: token, expiresIn: ttl, viewerToken,
    kind: share.kind, name: share.name, watermark: share.watermark,
    restrictions: { copy: !!share.disable_copy, print: !!share.disable_print, download: !!share.disable_download, screenshot: !!share.disable_screenshot },
    previewPages: Number(extraObj.previewPages) || 0,
    needProtect: needUnlock
  };
}

// ---------- docx 转换缓存 ----------
const docxCache = new Map();
async function renderDocx(file) {
  if (docxCache.has(file.id)) return docxCache.get(file.id);
  const mammoth = require('mammoth');
  const buf = await storage.readBuffer(file.stored_name);
  const result = await mammoth.convertToHtml(
    { buffer: buf },
    { convertImage: mammoth.images.imgElement(async (el) => {
        const b = await el.readAsBuffer();
        const ct = el.contentType || 'image/png';
        return { src: `data:${ct};base64,${b.toString('base64')}` };
      }) }
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui,'Microsoft YaHei',sans-serif;line-height:1.7;padding:24px;max-width:820px;margin:0 auto;color:#222">${result.value}</body></html>`;
  docxCache.set(file.id, html);
  return html;
}

// ---------- 微信 OAuth 共用 ----------
function wechatQrconnectUrl(state, origin) {
  const redirect = encodeURIComponent((config.BASE_URL || origin) + '/api/wechat/callback');
  return `https://open.weixin.qq.com/connect/qrconnect?appid=${config.WECHAT.APPID}` +
    `&redirect_uri=${redirect}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`;
}
async function finalizeWechat(state, openid, nickname) {
  let userId = state.user_id;
  if (!userId) {
    const exist = await db.findUserByOpenid(openid);
    if (exist) userId = exist.id;
    else {
      userId = uuid();
      await db.createUser({
        id: userId,
        email: (openid || 'wx_' + uuid().slice(0, 10)) + '@wechat.local',
        salt: '', hash: '', openid, createdAt: nowMs()
      });
    }
  }
  await db.confirmWechatState({ userId, openid, status: 'confirmed', state: state.state });

  if (state.purpose === 'login') {
    const token = uuid();
    await db.createUserToken({ token, userId, createdAt: nowMs(), expiresAt: nowMs() + config.USER_TOKEN_TTL_MS });
    await db.setWechatLoginToken({ token, state: state.state });
    return { kind: 'login', token, email: nickname || '微信用户' };
  }
  // verify：批准该访客并直接发放访问会话
  const share = await db.getShare(state.share_id);
  if (!share) return { kind: 'verify', error: 'share_gone' };
  await db.upsertApproval(share.id, state.viewer_token, 'approved', nowMs());
  // 注意：此处没有原始 req（来自微信回调/模拟确认），grantAccess 的 req 仅用于 IP/UA 日志，传 null 安全
  const g = await grantAccess(null, share, state.viewer_token);
  await db.setWechatVerifyIssued({ accessToken: g.accessToken, expiresIn: g.expiresIn, state: state.state });
  return { kind: 'verify', token: g.accessToken, expiresIn: g.expiresIn };
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  try {
    // 统一注入跨域头；OPTIONS 预检直接放行
    const _cors = corsHeaders(req);
    for (const k in _cors) res.setHeader(k, _cors[k]);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (req.method === 'GET' && !p.startsWith('/api/')) { return serveStatic(req, res, p); }

    // ---------- 用户认证 ----------
    if (req.method === 'POST' && p === '/api/auth/register') {
      const b = JSON.parse(await readBody(req, 1 << 20));
      const email = String(b.email || '').trim().toLowerCase();
      const pw = String(b.password || '');
      const inviteCode = String(b.inviteCode || '').trim();
      const realName = String(b.realName || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: 'invalid_email' });
      const pwErr = validatePassword(pw);
      if (pwErr) return sendJson(res, 400, { error: 'weak_password', message: pwErr });
      if (!realName) return sendJson(res, 400, { error: 'real_name_required', message: '请填写真实姓名' });

      // —— 防恶意注册 ——
      // 1) 蜜罐：隐藏字段被自动填充即判定为机器人，直接拒绝（不消耗数据库查询）
      if (String(b.company || '').trim()) return sendJson(res, 400, { error: 'bot_detected', message: '注册请求被拒绝' });
      // 2) 频率限制：同一 IP / 同一邮箱在窗口期内最多注册 N 次
      const regIp = clientIp(req);
      regSweep();
      if (regIp && regCount('ip:' + regIp) >= config.REG_IP_LIMIT)
        return sendJson(res, 429, { error: 'too_many_registrations', message: '当前网络 24 小时内注册次数过多，请稍后再试或联系管理员' });
      if (regCount('email:' + email) >= config.REG_EMAIL_LIMIT)
        return sendJson(res, 429, { error: 'too_many_registrations', message: '该邮箱 24 小时内注册尝试过多，请稍后再试' });
      // 3) 邀请制：开启后普通邮箱必须携带有效邀请码（超级管理员不受限）
      const isSuper = config.SUPER_ADMIN_EMAILS.includes(email);
      if (config.INVITE_ONLY && !isSuper && !inviteCode)
        return sendJson(res, 400, { error: 'invite_required', message: '当前为邀请制注册，请填写有效的公司邀请码' });
      // 计入本次尝试（用于窗口期统计）
      if (regIp) regHit('ip:' + regIp);
      regHit('email:' + email);

      if (await db.findUserByEmail(email)) return sendJson(res, 409, { error: 'email_exists', message: '该邮箱已注册' });
      // 超级管理员：仅由 SUPER_ADMIN_EMAILS 名单指定（不再把首个注册用户自动设为超管）
      let orgRes;
      if (isSuper) {
        // 超级管理员为全局角色，不归属某一门店（门店由超管在后台统一创建与分配）
        orgRes = { orgId: '', role: 'admin' };
      } else {
        orgRes = await resolveOrg(email, inviteCode);
        if (orgRes.error) return sendJson(res, 400, orgRes);
      }
      const { salt, hash } = hashPassword(pw);
      const uid = uuid();
      await db.createUser({ id: uid, email, salt, hash, openid: null, createdAt: nowMs(), orgId: orgRes.orgId, role: orgRes.role, isSuper, realName });
      // 记录注册行为，便于审计日志按“用户/关键词”追溯新账号
      await db.recordAudit(uid, 'create_user', uid, 'email=' + email);
      const token = uuid();
      await db.createUserToken({ token, userId: uid, createdAt: nowMs(), expiresAt: nowMs() + config.USER_TOKEN_TTL_MS });
      return sendJson(res, 200, { userToken: token, email, role: orgRes.role, isSuper });
    }
    if (req.method === 'POST' && p === '/api/auth/login') {
      const b = JSON.parse(await readBody(req, 1 << 20));
      const email = String(b.email || '').trim().toLowerCase();
      const pw = String(b.password || '');
      const user = await db.findUserByEmail(email);
      if (!user || !verifyPassword(pw, user.salt, user.password_hash)) return sendJson(res, 401, { error: 'bad_creds', message: '邮箱或密码错误' });
      if (user.disabled) return sendJson(res, 403, { error: 'disabled', message: '该账号已被禁用，请联系管理员' });
      // 超级管理员名单同步提权：已存在账号若邮箱在 SUPER_ADMIN_EMAILS 内且尚未标记，则升级为超管。
      // 与 Supabase ensureUser 路径一致，避免老账号在新版上线后永远无法成为超管（影响"用户管理"面板可见性）。
      let isSuper = !!Number(user.is_super);
      if (config.SUPER_ADMIN_EMAILS.includes(email) && !user.is_super) {
        await db.setUserSuper(user.id, 1);
        isSuper = true;
      }
      const token = uuid();
      await db.createUserToken({ token, userId: user.id, createdAt: nowMs(), expiresAt: nowMs() + config.USER_TOKEN_TTL_MS });
      return sendJson(res, 200, { userToken: token, email: user.email, realName: user.real_name || '', isSuper });
    }
    if (req.method === 'GET' && p === '/api/auth/me') {
      const token = u.searchParams.get('userToken');
      const idn = await resolveIdentity(token);
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_session' });
      const user = await db.getUser(idn.userId);
      const email = user ? user.email : '微信用户';
      let orgName = '';
      if (user && user.org_id) { const org = await db.getOrg(user.org_id); orgName = org ? org.name : ''; }
      return sendJson(res, 200, { id: user ? user.id : '', email, realName: user ? (user.real_name || '') : '', role: user ? user.role : 'member', orgId: user ? user.org_id : '', orgName, isSuper: user ? !!user.is_super : false, prefs: user ? parsePrefs(user.prefs) : {} });
    }
    if (req.method === 'PUT' && p === '/api/auth/profile') {
      const b = JSON.parse(await readBody(req, 1 << 20));
      const token = b.userToken || u.searchParams.get('userToken');
      const idn = await resolveIdentity(token);
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_session' });
      const user = await db.getUser(idn.userId);
      if (!user) return sendJson(res, 404, { error: 'no_user' });
      if (user.disabled) return sendJson(res, 403, { error: 'disabled', message: '该账号已被禁用，请联系管理员' });
      const patch = {};
      if (b.realName !== undefined) {
        const rn = String(b.realName || '').trim();
        if (!rn) return sendJson(res, 400, { error: 'real_name_required', message: '真实姓名不能为空' });
        patch.realName = rn;
      }
      if (b.prefs !== undefined) {
        if (typeof b.prefs !== 'object' || b.prefs === null || Array.isArray(b.prefs)) return sendJson(res, 400, { error: 'bad_prefs', message: '默认参数格式错误' });
        patch.prefs = JSON.stringify(b.prefs);
      }
      if (Object.keys(patch).length) await db.updateUserProfile(user.id, patch);
      const refreshed = await db.getUser(user.id);
      return sendJson(res, 200, { ok: true, realName: refreshed.real_name || '', prefs: parsePrefs(refreshed.prefs) });
    }
    if (req.method === 'POST' && p === '/api/auth/change-password') {
      const b = JSON.parse(await readBody(req, 1 << 20));
      const token = b.userToken || u.searchParams.get('userToken');
      const idn = await resolveIdentity(token);
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_session' });
      const user = await db.getUser(idn.userId);
      if (!user) return sendJson(res, 404, { error: 'no_user' });
      if (user.disabled) return sendJson(res, 403, { error: 'disabled', message: '该账号已被禁用，请联系管理员' });
      const oldPw = String(b.oldPassword || '');
      const newPw = String(b.newPassword || '');
      if (!verifyPassword(oldPw, user.salt, user.password_hash)) return sendJson(res, 400, { error: 'bad_old', message: '原密码错误' });
      const pwErr = validatePassword(newPw);
      if (pwErr) return sendJson(res, 400, { error: 'weak_password', message: pwErr });
      if (oldPw === newPw) return sendJson(res, 400, { error: 'same_password', message: '新密码不能与原密码相同' });
      const { salt, hash } = hashPassword(newPw);
      await db.updateUserPassword(user.id, salt, hash);
      // 改密后废除其它会话，仅保留当前令牌（提升安全性）
      await db.revokeOtherTokens(user.id, token);
      return sendJson(res, 200, { ok: true });
    }

    // Supabase 用户首登：确保本地用户行 + 归属组织（邀请码 / 域名 / 开放多租户）
    if (req.method === 'POST' && p === '/api/auth/bootstrap') {
      const body = JSON.parse(await readBody(req, 1 << 20));
      const token = body.userToken || u.searchParams.get('userToken');
      if (!config.SUPABASE.enabled) return sendJson(res, 400, { error: 'supabase_disabled', message: '未启用 Supabase 身份体系' });
      const payload = await verifySupabaseToken(token);
      if (!payload) return sendJson(res, 401, { error: 'invalid_token' });
      const inviteCode = String(body.inviteCode || '').trim();
      const user = await db.ensureUser({ sub: payload.sub, email: payload.email || '', inviteCode });
      if (user.error) return sendJson(res, 400, user);
      if (user.disabled) return sendJson(res, 403, { error: 'disabled', message: '该账号已被禁用，请联系管理员' });
      let orgName = '';
      if (user.org_id) { const org = await db.getOrg(user.org_id); orgName = org ? org.name : ''; }
      return sendJson(res, 200, { email: user.email, role: user.role, orgId: user.org_id, orgName, isSuper: !!user.is_super });
    }

    // ---------- 微信扫码（开放平台网站应用 snsapi_login）----------
    if (req.method === 'POST' && p === '/api/wechat/start') {
      const b = JSON.parse(await readBody(req, 1 << 20));
      const purpose = b.purpose === 'verify' ? 'verify' : 'login';
      const state = uuid();
      const row = { state, purpose, share_id: b.share || null, viewer_token: b.viewerToken || uuid(), status: 'pending', created_at: nowMs(), expires_at: nowMs() + 10 * 60 * 1000 };
      await db.createWechatState({
        state, userId: null, openid: null, status: 'pending', createdAt: nowMs(), purpose,
        shareId: row.share_id, viewerToken: row.viewer_token, expiresAt: row.expires_at
      });
      if (config.WECHAT.enabled) {
        const url = wechatQrconnectUrl(state, u.origin);
        return sendJson(res, 200, { state, mode: 'real', qrUrl: url, viewerToken: row.viewer_token });
      }
      const QRCode = require('qrcode');
      const qr = await QRCode.toDataURL(`${u.origin}/wechat-scan.html?state=${state}`);
      return sendJson(res, 200, { state, mode: 'sim', qr, viewerToken: row.viewer_token });
    }
    if (req.method === 'GET' && p === '/api/wechat/callback') {
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const ws = await db.getWechatState(state);
      if (!ws || ws.status !== 'pending') return sendHtml(res, 400, '<h3>验证状态无效或已过期</h3><p>请关闭此窗口后重试。</p>');
      let openid = null, nickname = '微信用户';
      if (config.WECHAT.enabled && code) {
        try {
          const tk = await httpsGetJson(`https://api.weixin.qq.com/sns/oauth2/access_token?appid=${config.WECHAT.APPID}&secret=${config.WECHAT.SECRET}&code=${code}&grant_type=authorization_code`);
          if (tk.errcode) return sendHtml(res, 400, '<h3>微信授权失败</h3><p>' + (tk.errmsg || '') + '</p>');
          openid = tk.openid;
          try {
            const info = await httpsGetJson(`https://api.weixin.qq.com/sns/userinfo?access_token=${tk.access_token}&openid=${tk.openid}`);
            if (info.nickname) nickname = info.nickname;
          } catch (e) { /* 昵称非必需 */ }
        } catch (e) {
          return sendHtml(res, 502, '<h3>微信接口调用失败</h3><p>' + e.message + '</p>');
        }
      } else {
        openid = 'wx_' + uuid().slice(0, 12); // 模拟模式下的假 openid
      }
      const fin = await finalizeWechat(ws, openid, nickname);
      if (fin.error) return sendHtml(res, 400, '<h3>验证失败</h3>');
      return sendHtml(res, 200, '<h3 style="font-family:system-ui">✅ 验证成功</h3><p>请返回原页面继续。</p><script>try{window.close();}catch(e){}</script>');
    }
    if (req.method === 'POST' && p === '/api/wechat/sim') {
      const b = JSON.parse(await readBody(req, 1 << 20));
      const ws = await db.getWechatState(b.state);
      if (!ws || ws.status !== 'pending') return sendJson(res, 403, { error: 'bad_state' });
      const fin = await finalizeWechat(ws, 'wx_' + uuid().slice(0, 12), '微信用户');
      if (fin.error) return sendJson(res, 400, { error: fin.error });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/wechat/check') {
      const state = u.searchParams.get('state');
      const ws = await db.getWechatState(state);
      if (!ws) return sendJson(res, 404, { error: 'no_state' });
      if (ws.status === 'confirmed') {
        if (ws.purpose === 'login') return sendJson(res, 200, { ok: true, userToken: ws.issued_token, email: '微信用户' });
        return sendJson(res, 200, { ok: true, verified: true, accessToken: ws.issued_token, expiresIn: Number(ws.access_token) || 0 });
      }
      return sendJson(res, 200, { ok: false, status: ws.status });
    }

    // 上传文件（必须登录，匿名用户不允许上传/分享）
    if (req.method === 'POST' && p === '/api/upload') {
      const uploadToken = u.searchParams.get('userToken');
      const uploadIdn = await resolveIdentity(uploadToken);
      if (!uploadIdn || uploadIdn.type !== 'user') return sendJson(res, 401, { error: 'no_auth', message: '请先登录后再上传文件' });
      const name = u.searchParams.get('name') ? decodeURIComponent(u.searchParams.get('name')) : 'file';
      const mime = u.searchParams.get('mime') || 'application/octet-stream';
      const ext = path.extname(name).toLowerCase();
      // 白名单校验：不支持的格式在读取文件体之前直接拒绝，避免浪费带宽上传
      const kind = classifyKind(ext, mime);
      if (!ALLOWED_KINDS.has(kind)) {
        return sendJson(res, 415, { error: 'unsupported_type', message: '不支持的文件格式：' + (ext || mime || '未知') + '。' + SUPPORTED_HINT });
      }
      const buf = await readBody(req);
      if (!buf.length) return sendJson(res, 400, { error: 'empty' });
      const fileId = uuid();
      const stored = fileId + ext;
      await storage.save(stored, buf, mime);
      // 源文件：尝试在上传时生成网页预览图（失败则降级为仅下载，不阻断主流程）
      let previewPath = null;
      if (kind === 'source') {
        try {
          const pv = await preview.generatePreview(ext, mime, buf);
          if (pv.ok) {
            const pvName = fileId + '_preview.png';
            await storage.save(pvName, pv.buffer, 'image/png');
            previewPath = pvName;
          }
        } catch (e) {
          console.warn('[preview] 生成预览失败，降级为仅下载：', e.message);
        }
      }
      await db.createFile({ id: fileId, originalName: name, storedName: stored, mime, size: buf.length, kind, previewPath, createdAt: nowMs() });
      return sendJson(res, 200, { fileId, name, kind, hasPreview: !!previewPath, size: buf.length });
    }

    // 创建分享（必须登录，禁止匿名分享）
    if (req.method === 'POST' && p === '/api/share') {
      const body = JSON.parse(await readBody(req, 1 << 20));
      if (!body.userToken) return sendJson(res, 401, { error: 'no_auth', message: '请先登录后再创建分享' });
      const idn = await resolveIdentity(body.userToken);
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth', message: '登录已过期，请重新登录' });
      const me = await db.getUser(idn.userId);
      if (!me) return sendJson(res, 401, { error: 'no_auth', message: '账号不存在' });
      // 未归属门店禁止创建分享：新注册未分配门店的用户无法分享，需由超管分配门店
      if (!me.org_id) return sendJson(res, 403, { error: 'no_store', message: '您尚未归属任何门店，暂不能创建分享，请联系管理员为您分配门店' });
      const file = await db.getFile(body.fileId);
      if (!file) return sendJson(res, 404, { error: 'file_not_found' });
      const shareId = uuid().slice(0, 12);
      const ownerToken = uuid();
      const s = body.settings || {};
      const ownerId = idn.userId;
      const am = (s.authMode === 'approve' || s.authMode === 'wechat') ? s.authMode : 'open';
      await db.createShare({
        shareId, fileId: file.id, ownerId, ownerToken, name: s.name || file.original_name, kind: file.kind,
        maxViewers: Number(s.maxViewers) || 0, maxViews: Number(s.maxViews) || 0, durationSec: Number(s.durationSec) || 0,
        expiresAt: s.expiresAt ? Number(s.expiresAt) : null, accessCode: s.accessCode || null, authMode: am,
        watermark: s.watermark || '',
        restrictions: { copy: !!s.disableCopy, print: !!s.disablePrint, download: !!s.disableDownload, screenshot: !!s.disableScreenshot },
        extra: s.extra || null,
        createdAt: nowMs()
      });
      const link = `${(config.BASE_URL || u.origin)}/viewer.html?share=${shareId}`;
      const QRCode = require('qrcode');
      const qr = await QRCode.toDataURL(link);
      return sendJson(res, 200, { shareId, ownerToken, link, qr, name: s.name || file.original_name });
    }

    // 文件列表（登录可见；超管 scope=all 看全部，并可按 owner 邮箱筛选）
    if (req.method === 'GET' && p === '/api/files') {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      let files;
      if (isSuper && u.searchParams.get('scope') === 'all') files = await db.listAllFiles();
      else files = await db.listFilesForUser(idn.userId);
      // 超管可进一步按人员筛选（owner 邮箱模糊匹配）
      const owner = (u.searchParams.get('owner') || '').trim().toLowerCase();
      if (isSuper && owner) files = files.filter(f => (f.owner_email || '').toLowerCase().includes(owner));
      const list = files.map(f => ({
        fileId: f.id, name: f.name, size: Number(f.size) || 0, kind: f.kind,
        shareCount: Number(f.share_count) || 0, shareId: f.share_id || null, shareName: f.share_name || '',
        ownerEmail: isSuper ? (f.owner_email || '（孤儿/未分享）') : undefined,
        createdAt: Number(f.createdAt)
      }));
      return sendJson(res, 200, { files: list, isSuper });
    }

    // 替换文件：保持 file_id 不变 → 分享链接永远指向最新文件；原文件字节仅作备份不删（可回滚）
    if (req.method === 'POST' && /^\/api\/files\/[^\/]+\/replace$/.test(p)) {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      const fileId = p.split('/')[3];
      const old = await db.getFile(fileId);
      if (!old) return sendJson(res, 404, { error: 'file_not_found' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      const shares = await db.listSharesByFile(fileId);
      if (!isSuper && !shares.some(s => s.owner_id === idn.userId)) return sendJson(res, 403, { error: 'no_auth', message: '无权操作该文件' });
      const buf = await readBody(req);
      if (!buf.length) return sendJson(res, 400, { error: 'empty' });
      const name = u.searchParams.get('name') ? decodeURIComponent(u.searchParams.get('name')) : old.original_name;
      const mime = u.searchParams.get('mime') || old.mime || 'application/octet-stream';
      const ext = path.extname(name).toLowerCase();
      // 白名单校验：替换为不支持的格式同样拒绝
      const kind = classifyKind(ext, mime);
      if (!ALLOWED_KINDS.has(kind)) {
        return sendJson(res, 415, { error: 'unsupported_type', message: '不支持的文件格式：' + (ext || mime || '未知') + '。' + SUPPORTED_HINT });
      }
      const newStored = uuid() + ext;
      await storage.save(newStored, buf, mime);
      let previewPath = old.preview_path;
      if (kind === 'source') {
        try {
          const pv = await preview.generatePreview(ext, mime, buf);
          if (pv.ok) { const pvName = uuid() + '_preview.png'; await storage.save(pvName, pv.buffer, 'image/png'); previewPath = pvName; }
        } catch (e) { console.warn('[preview] 替换预览生成失败：', e.message); }
      }
      await db.replaceFileById(fileId, { storedName: newStored, mime, size: buf.length, kind, previewPath, originalName: name });
      // 删除旧存储字节（替换完成，保留 file_id；如需回滚可在存储层保留版本）
      try { await storage.delete(old.stored_name); } catch (e) {}
      if (old.preview_path && old.preview_path !== previewPath) { try { await storage.delete(old.preview_path); } catch (e) {} }
      // 同步更新引用该文件的分享的 kind（内容类型可能变化）
      for (const sh of shares) { await db.run('UPDATE shares SET kind=?, updated_at=? WHERE id=?', [kind, nowMs(), sh.id]); }
      await db.recordAudit(idn.userId, 'replace_file', fileId, `name=${name};shares=${shares.length}`);
      return sendJson(res, 200, { fileId, kind, name, shareCount: shares.length, message: '文件已更新，原有分享链接保持不变' });
    }

    // 删除文件：仅当无分享引用时允许（被引用须先处理分享）
    if (req.method === 'DELETE' && /^\/api\/files\/[^\/]+$/.test(p)) {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      const fileId = p.split('/')[3];
      const old = await db.getFile(fileId);
      if (!old) return sendJson(res, 404, { error: 'file_not_found' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      const shares = await db.listSharesByFile(fileId);
      if (!isSuper && !shares.some(s => s.owner_id === idn.userId)) return sendJson(res, 403, { error: 'no_auth', message: '无权操作该文件' });
      // 仅当存在“生效中”的分享引用时才拦截；已销毁/已失效的分享不影响删除（一并清理）
      const active = shares.filter(s => s.status === 'active');
      if (active.length) return sendJson(res, 409, { error: 'file_in_use', message: '该文件仍被以下生效中的分享引用，请先处理分享：', shares: active.map(s => ({ id: s.id, name: s.name })) });
      for (const sh of shares) { await db.deleteShareRow(sh.id); }
      try { await storage.delete(old.stored_name); } catch (e) {}
      if (old.preview_path) { try { await storage.delete(old.preview_path); } catch (e) {} }
      await db.deleteFileRow(fileId);
      await db.recordAudit(idn.userId, 'delete_file', fileId, `name=${old.original_name};shares=${shares.length}`);
      return sendJson(res, 200, { ok: true });
    }

    // 重命名文件：保持 file_id / 分享链接不变，仅改展示名
    if (req.method === 'PATCH' && /^\/api\/files\/[^\/]+$/.test(p)) {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      const fileId = p.split('/')[3];
      const old = await db.getFile(fileId);
      if (!old) return sendJson(res, 404, { error: 'file_not_found' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      const shares = await db.listSharesByFile(fileId);
      if (!isSuper && !shares.some(s => s.owner_id === idn.userId)) return sendJson(res, 403, { error: 'no_auth', message: '无权操作该文件' });
      let body;
      try { body = JSON.parse(await readBody(req, 1 << 16)); } catch (e) { return sendJson(res, 400, { error: 'bad_json' }); }
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'empty_name', message: '文件名不能为空' });
      await db.renameFileById(fileId, name);
      // 同步更新引用该文件的分享名称，保持列表展示一致
      for (const sh of shares) { await db.run('UPDATE shares SET name=?, updated_at=? WHERE id=?', [name, nowMs(), sh.id]); }
      await db.recordAudit(idn.userId, 'rename_file', fileId, `from=${old.original_name};to=${name}`);
      return sendJson(res, 200, { fileId, name, message: '已重命名' });
    }

    // 下载文件：按 fileId 直下（文件本体可能在 COS），鉴权后流式返回
    if (req.method === 'GET' && /^\/api\/files\/[^\/]+\/download$/.test(p)) {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      const fileId = p.split('/')[3];
      const f = await db.getFile(fileId);
      if (!f) return sendJson(res, 404, { error: 'file_not_found' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      const shares = await db.listSharesByFile(fileId);
      if (!isSuper && !shares.some(s => s.owner_id === idn.userId)) return sendJson(res, 403, { error: 'no_auth', message: '无权下载该文件' });
      let buf;
      try { buf = await storage.readBuffer(f.stored_name); } catch (e) { return sendJson(res, 404, { error: 'no_data', message: '文件存储不存在' }); }
      const disp = 'attachment; filename="' + encodeURIComponent(f.original_name) + '"; filename*=UTF-8\'\'' + encodeURIComponent(f.original_name);
      res.setHeader('Content-Type', f.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', disp);
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }

    // 预览图：图像类型返回原图，其它类型返回已生成的预览图；无可用预览则 404
    if (req.method === 'GET' && /^\/api\/files\/[^\/]+\/preview$/.test(p)) {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      const fileId = p.split('/')[3];
      const f = await db.getFile(fileId);
      if (!f) return sendJson(res, 404, { error: 'file_not_found' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      const shares = await db.listSharesByFile(fileId);
      if (!isSuper && !shares.some(s => s.owner_id === idn.userId)) return sendJson(res, 403, { error: 'no_auth', message: '无权预览该文件' });
      let stored = null, mime = 'image/png';
      if (f.kind === 'image') { stored = f.stored_name; mime = f.mime || 'image/png'; }
      else if (f.preview_path) { stored = f.preview_path; }
      if (!stored) return sendJson(res, 404, { error: 'no_preview', message: '该文件无可用预览' });
      let buf;
      try { buf = await storage.readBuffer(stored); } catch (e) { return sendJson(res, 404, { error: 'no_data' }); }
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', 'inline; filename="preview"');
      res.setHeader('Content-Length', buf.length);
      return res.end(buf);
    }

    // 从已有文件一键创建分享（已有生效分享则直接复用其链接，避免重复创建）
    if (req.method === 'POST' && /^\/api\/files\/[^\/]+\/share$/.test(p)) {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      const fileId = p.split('/')[3];
      const f = await db.getFile(fileId);
      if (!f) return sendJson(res, 404, { error: 'file_not_found' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      const shares = await db.listSharesByFile(fileId);
      if (!isSuper && !shares.some(s => s.owner_id === idn.userId)) return sendJson(res, 403, { error: 'no_auth', message: '无权操作该文件' });
      const active = shares.find(s => s.status === 'active' && (isSuper || s.owner_id === idn.userId));
      if (active) {
        const link = `${(config.BASE_URL || u.origin)}/viewer.html?share=${active.id}`;
        return sendJson(res, 200, { shareId: active.id, link, reused: true, name: f.original_name });
      }
      let quickSettings = {};
      try { quickSettings = JSON.parse(await readBody(req, 1 << 16)); } catch (e) {}
      const qs = quickSettings || {};
      const am = (qs.authMode === 'approve' || qs.authMode === 'wechat') ? qs.authMode : 'open';
      const extra = qs.extra || null;
      const shareId = uuid().slice(0, 12);
      const ownerToken = uuid();
      await db.createShare({
        shareId, fileId: f.id, ownerId: idn.userId, ownerToken, name: qs.name || f.original_name, kind: f.kind,
        maxViewers: Number(qs.maxViewers) || 0, maxViews: Number(qs.maxViews) || 0, durationSec: Number(qs.durationSec) || 0,
        expiresAt: qs.expiresAt ? Number(qs.expiresAt) : null, accessCode: qs.accessCode || null, authMode: am,
        watermark: qs.watermark || '',
        restrictions: {
          copy: !!qs.disableCopy, print: !!qs.disablePrint,
          download: !!qs.disableDownload, screenshot: !!qs.disableScreenshot
        },
        extra, createdAt: nowMs()
      });
      const link = `${(config.BASE_URL || u.origin)}/viewer.html?share=${shareId}`;
      const QRCode = require('qrcode');
      const qr = await QRCode.toDataURL(link);
      await db.recordAudit(idn.userId, 'create_share', shareId, `from_file=${fileId};name=${f.original_name}`);
      return sendJson(res, 200, { shareId, ownerToken, link, qr, name: qs.name || f.original_name, reused: false });
    }

    // 批量删除文件：仅无“生效中”分享引用的可删；被引用者返回失败明细，不中断其余
    if (req.method === 'POST' && p === '/api/files/batch-delete') {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      let body;
      try { body = JSON.parse(await readBody(req, 1 << 20)); } catch (e) { return sendJson(res, 400, { error: 'bad_json' }); }
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
      if (!ids.length) return sendJson(res, 400, { error: 'empty' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      const ok = [], failed = [];
      for (const fileId of ids) {
        const old = await db.getFile(fileId);
        if (!old) { failed.push({ fileId, reason: 'not_found' }); continue; }
        const shares = await db.listSharesByFile(fileId);
        if (!isSuper && !shares.some(s => s.owner_id === idn.userId)) { failed.push({ fileId, name: old.original_name, reason: 'no_auth' }); continue; }
        const active = shares.filter(s => s.status === 'active');
        if (active.length) { failed.push({ fileId, name: old.original_name, reason: 'in_use', shares: active.map(s => s.name) }); continue; }
        for (const sh of shares) { await db.deleteShareRow(sh.id); }
        try { await storage.delete(old.stored_name); } catch (e) {}
        if (old.preview_path) { try { await storage.delete(old.preview_path); } catch (e) {} }
        await db.deleteFileRow(fileId);
        await db.recordAudit(idn.userId, 'delete_file', fileId, `batch;name=${old.original_name}`);
        ok.push(fileId);
      }
      return sendJson(res, 200, { ok, failed, deleted: ok.length, failedCount: failed.length });
    }

    // 数据概览（超管全局；普通登录用户仅本人数据）
    if (req.method === 'GET' && p === '/api/dashboard') {
      const idn = await resolveIdentity(u.searchParams.get('userToken'));
      if (!idn || idn.type !== 'user') return sendJson(res, 401, { error: 'no_auth' });
      const me = await db.getUser(idn.userId);
      const isSuper = !!(me && me.is_super);
      const totals = await db.dashboardTotals(idn.userId, isSuper);
      const topShares = await db.dashboardTopShares(idn.userId, isSuper);
      const recent = await db.dashboardRecentViewers(idn.userId, isSuper);
      return sendJson(res, 200, {
        isSuper, scope: isSuper ? 'global' : 'mine',
        totals: {
          fileCount: totals.fileCount, shareCount: totals.shareCount,
          totalOpens: totals.totalOpens, totalViewers: totals.totalViewers
        },
        topShares: topShares.map(s => ({ shareId: s.id, name: s.name, ownerEmail: s.owner_email || '(匿名)', opens: Number(s.opens) || 0, viewers: Number(s.viewers) || 0 })),
        recentViewers: recent.map(v => ({
          viewerToken: v.viewer_token, shareName: v.share_name || '', ownerEmail: v.owner_email || '',
          events: Number(v.events) || 0, lastAt: Number(v.last_at),
          loc: [v.country, v.region, v.city].filter(Boolean).join('·'), ip: v.ip || '',
          device: [v.device, v.os].filter(Boolean).join('/'), browser: v.browser || ''
        }))
      });
    }

    // 获取分享元数据
    if (req.method === 'GET' && p.startsWith('/api/share/')) {
      const shareId = p.split('/')[3];
      const share = await db.getShareMeta(shareId);
      if (!share) return sendJson(res, 404, { error: 'not_found' });
      const requiresCode = !!share.access_code;
      let extraObj = {};
      try { extraObj = share.extra ? JSON.parse(share.extra) : {}; } catch (e) { extraObj = {}; }
      // 保护密码不暴露给前端，仅返回是否需要密码及预览页数
      const safeExtra = {
        previewPages: Number(extraObj.previewPages) || 0,
        needProtect: !!(extraObj.previewPages && extraObj.protectPassword)
      };
      return sendJson(res, 200, {
        shareId: share.id, name: share.name, kind: share.kind, status: share.status,
        preview: !!share.preview_path,
        requiresCode, authMode: share.auth_mode, watermark: share.watermark,
        restrictions: {
          copy: !!share.disable_copy, print: !!share.disable_print,
          download: !!share.disable_download, screenshot: !!share.disable_screenshot
        },
        extra: safeExtra
      });
    }

    // 解锁后续内容：校验保护密码并标记会话已解锁
    if (req.method === 'POST' && /^\/api\/share\/[^\/]+\/unlock$/.test(p)) {
      const shareId = p.split('/')[3];
      const body = JSON.parse(await readBody(req, 1 << 20));
      const accessToken = body.accessToken;
      const sess = accessToken ? await db.getSession(accessToken) : null;
      if (!sess || Number(sess.expires_at) < nowMs() || sess.share_id !== shareId)
        return sendJson(res, 403, { error: 'invalid_session', message: '会话无效或已过期，请重新申请打开' });
      const share = await db.getShare(shareId);
      if (!share) return sendJson(res, 404, { error: 'not_found' });
      let extraObj = {};
      try { extraObj = share.extra ? JSON.parse(share.extra) : {}; } catch (e) { extraObj = {}; }
      if (!extraObj.protectPassword) return sendJson(res, 200, { ok: true });
      if (body.password !== extraObj.protectPassword)
        return sendJson(res, 403, { error: 'wrong_password', message: '密码错误' });
      await db.updateSessionUnlock(accessToken, true);
      return sendJson(res, 200, { ok: true });
    }

    // 访问鉴权（核心权限引擎）
    if (req.method === 'POST' && p === '/api/access') {
      const body = JSON.parse(await readBody(req, 1 << 20));
      const shareId = body.shareId, viewerToken = body.viewerToken || uuid();
      const share = await db.getShare(shareId);
      if (!share) return sendJson(res, 404, { error: 'not_found' });
      if (share.status !== 'active') return sendJson(res, 403, { error: 'destroyed', message: '该文档已下架或销毁' });
      if (share.expires_at && nowMs() > Number(share.expires_at)) return sendJson(res, 403, { error: 'expired', message: '分享链接已过期' });

      const totalViews = await db.countOpens(shareId);
      const distinct = await db.distinctViewers(shareId);
      const otherViewers = distinct.filter(v => v !== viewerToken).length;
      if (share.max_viewers > 0 && otherViewers >= share.max_viewers)
        return sendJson(res, 403, { error: 'limit_viewers', message: '访问人数已达上限' });
      if (share.max_views > 0 && totalViews >= share.max_views)
        return sendJson(res, 403, { error: 'limit_views', message: '阅读次数已达上限' });

      if (share.access_code && body.code !== share.access_code)
        return sendJson(res, 200, { needCode: true, message: '需要访问码' });

      if (share.auth_mode === 'approve' || share.auth_mode === 'wechat') {
        const ap = await db.getApproval(shareId, viewerToken);
        if (!ap || ap.status !== 'approved') {
          if (!ap) await db.touchApproval(shareId, viewerToken, nowMs());
          if (share.auth_mode === 'wechat')
            return sendJson(res, 200, { needWechat: true, message: '请使用微信扫码验证' });
          return sendJson(res, 200, { needApproval: true, message: '已发送访问申请，等待分享者授权' });
        }
      }
      return sendJson(res, 200, await grantAccess(req, share, viewerToken));
    }

    // 内容下发（需有效会话）
    if (req.method === 'GET' && p.startsWith('/api/content/')) {
      const shareId = p.split('/')[3];
      const at = u.searchParams.get('at');
      const sess = await db.getSession(at);
      if (!sess || Number(sess.expires_at) < nowMs()) return sendJson(res, 403, { error: 'invalid_session' });
      // 越权防护：会话必须归属于当前分享
      if (sess.share_id !== shareId) return sendJson(res, 403, { error: 'forbidden', message: '会话与分享不匹配' });
      const share = await db.getShare(shareId);
      if (!share || share.status !== 'active') return sendJson(res, 403, { error: 'destroyed' });
      const file = await db.getFile(share.file_id);
      if (!file) return sendJson(res, 404, { error: 'no_file' });
      if (file.kind === 'docx') {
        const html = await renderDocx(file);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      const data = await storage.readBuffer(file.stored_name);
      const ct = file.kind === 'pdf' ? 'application/pdf' : (file.mime || 'application/octet-stream');
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      return res.end(data);
    }

    // 源文件预览图下发（需有效会话，与 /api/content 同等鉴权）
    if (req.method === 'GET' && p.startsWith('/api/preview/')) {
      const shareId = p.split('/')[3];
      const at = u.searchParams.get('at');
      const sess = await db.getSession(at);
      if (!sess || Number(sess.expires_at) < nowMs()) return sendJson(res, 403, { error: 'invalid_session' });
      if (sess.share_id !== shareId) return sendJson(res, 403, { error: 'forbidden', message: '会话与分享不匹配' });
      const share = await db.getShare(shareId);
      if (!share || share.status !== 'active') return sendJson(res, 403, { error: 'destroyed' });
      const file = await db.getFile(share.file_id);
      if (!file || !file.preview_path) return sendJson(res, 404, { error: 'no_preview' });
      const data = await storage.readBuffer(file.preview_path);
      const isJpg = /\.jpe?g$/i.test(file.preview_path);
      res.writeHead(200, { 'Content-Type': isJpg ? 'image/jpeg' : 'image/png', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      return res.end(data);
    }

    // 访问日志上报
    if (req.method === 'POST' && p === '/api/log') {
      const body = JSON.parse(await readBody(req, 1 << 20));
      await db.recordProgress({
        shareId: body.shareId, viewerToken: body.viewerToken, ip: clientIp(req),
        ua: req.headers['user-agent'] || '', event: body.event || 'progress',
        progress: String(body.progress || ''), now: nowMs()
      });
      return sendJson(res, 200, { ok: true });
    }

    // 管理后台：列出我的分享（必须登录，不再接受匿名 ownerToken）
    if (req.method === 'GET' && p.startsWith('/api/admin/') && p.split('/').length === 4) {
      const token = p.split('/')[3];
      const idn = await resolveIdentity(token);
      if (!idn || idn.type !== 'user') return sendJson(res, 403, { error: 'no_auth', message: '请先登录' });
      const shares = await db.listMySharesById(idn.userId);
      const list = shares.map(s => ({
        shareId: s.id, fileId: s.file_id, name: s.name, kind: s.kind, status: s.status,
        opens: s.opens, viewers: s.viewers,
        maxViewers: s.max_viewers, maxViews: s.max_views, durationSec: s.duration_sec,
        expiresAt: s.expires_at, accessCode: s.access_code, authMode: s.auth_mode, watermark: s.watermark,
        restrictions: { copy: !!s.disable_copy, print: !!s.disable_print, download: !!s.disable_download, screenshot: !!s.disable_screenshot },
        createdAt: s.created_at, link: `/viewer.html?share=${s.id}`
      }));
      return sendJson(res, 200, { shares: list });
    }

    // 管理后台：单条分享的访问日志
    if (req.method === 'GET' && p.startsWith('/api/admin/') && p.endsWith('/logs')) {
      const parts = p.split('/'); const token = parts[3]; const shareId = parts[5];
      const share = await resolveShareForAdmin(token, shareId);
      if (!share) return sendJson(res, 403, { error: 'no_auth' });
      const logs = await db.getShareLogs(shareId);
      return sendJson(res, 200, { logs });
    }

    // 管理后台：待授权列表
    if (req.method === 'GET' && p.startsWith('/api/admin/') && p.endsWith('/approvals')) {
      const parts = p.split('/'); const token = parts[3]; const shareId = parts[5];
      const share = await resolveShareForAdmin(token, shareId);
      if (!share) return sendJson(res, 403, { error: 'no_auth' });
      const aps = await db.getPendingApprovals(shareId);
      return sendJson(res, 200, { approvals: aps });
    }

    // 管理后台：销毁 / 恢复
    if (req.method === 'POST' && /\/api\/admin\/[^\/]+\/share\/[^\/]+\/(destroy|restore)$/.test(p)) {
      const parts = p.split('/'); const token = parts[3]; const shareId = parts[5]; const action = parts[6];
      const share = await resolveShareForAdmin(token, shareId);
      if (!share) return sendJson(res, 403, { error: 'no_auth' });
      await db.setShareStatus(shareId, action === 'destroy' ? 'destroyed' : 'active', nowMs());
      const idn = await resolveIdentity(token);
      await db.recordAudit(idn && idn.userId, action === 'destroy' ? 'destroy_share' : 'restore_share', shareId, `name=${share.name}`);
      return sendJson(res, 200, { ok: true, status: action === 'destroy' ? 'destroyed' : 'active' });
    }

    // 管理后台：彻底删除分享（同时清理访问记录、授权、会话；当文件不再被其他分享引用时删除文件字节）
    if (req.method === 'DELETE' && /^\/api\/admin\/[^\/]+\/share\/[^\/]+$/.test(p)) {
      const parts = p.split('/'); const token = parts[3]; const shareId = parts[5];
      const share = await resolveShareForAdmin(token, shareId);
      if (!share) return sendJson(res, 403, { error: 'no_auth' });
      await db.run('DELETE FROM logs WHERE share_id=?', [shareId]);
      await db.run('DELETE FROM approvals WHERE share_id=?', [shareId]);
      await db.run('DELETE FROM sessions WHERE share_id=?', [shareId]);
      await db.deleteShareRow(shareId);
      let fileDeleted = false;
      if (share.file_id) {
        const cnt = await db.get('SELECT COUNT(*) AS c FROM shares WHERE file_id=? AND id<>?', [share.file_id, shareId]);
        if (!cnt || Number(cnt.c) === 0) {
          const f = await db.getFile(share.file_id);
          if (f) {
            try { await storage.delete(f.stored_name); } catch (e) {}
            if (f.preview_path) { try { await storage.delete(f.preview_path); } catch (e) {} }
            await db.deleteFileRow(share.file_id);
            fileDeleted = true;
          }
        }
      }
      const idn = await resolveIdentity(token);
      await db.recordAudit(idn && idn.userId, 'delete_share', shareId, `name=${share.name};fileDeleted=${fileDeleted}`);
      return sendJson(res, 200, { ok: true, fileDeleted });
    }

    // 管理后台：修改权限
    if (req.method === 'PUT' && /\/api\/admin\/[^\/]+\/share\/[^\/]+\/settings$/.test(p)) {
      const parts = p.split('/'); const token = parts[3]; const shareId = parts[5];
      const share = await resolveShareForAdmin(token, shareId);
      if (!share) return sendJson(res, 403, { error: 'no_auth' });
      const s = JSON.parse(await readBody(req, 1 << 20));
      await db.updateShareSettings(shareId, s, nowMs());
      const idn = await resolveIdentity(token);
      await db.recordAudit(idn && idn.userId, 'edit_share', shareId, `name=${share.name}`);
      return sendJson(res, 200, { ok: true });
    }

    // 管理后台：审批
    if (req.method === 'POST' && /\/api\/admin\/[^\/]+\/share\/[^\/]+\/approve$/.test(p)) {
      const parts = p.split('/'); const token = parts[3]; const shareId = parts[5];
      const share = await resolveShareForAdmin(token, shareId);
      if (!share) return sendJson(res, 403, { error: 'no_auth' });
      const b = JSON.parse(await readBody(req, 1 << 20));
      const decision = b.decision === 'reject' ? 'rejected' : 'approved';
      await db.upsertApproval(shareId, b.viewerToken, decision, nowMs());
      const idn = await resolveIdentity(token);
      await db.recordAudit(idn && idn.userId, 'approve_share', shareId, `viewer=${b.viewerToken ? b.viewerToken.slice(0,8) : ''};decision=${decision}`);
      return sendJson(res, 200, { ok: true, decision });
    }

    // 管理后台：查看者明细（IP/时间/设备/位置）
    if (req.method === 'GET' && /\/api\/admin\/[^\/]+\/share\/[^\/]+\/viewers$/.test(p)) {
      const parts = p.split('/'); const token = parts[3]; const shareId = parts[5];
      const share = await resolveShareForAdmin(token, shareId);
      if (!share) return sendJson(res, 403, { error: 'no_auth' });
      const viewers = await db.getShareViewers(shareId);
      return sendJson(res, 200, { viewers });
    }

    // ---------- 组织后台（店长） ----------
    // 全店分享
    if (req.method === 'GET' && p === '/api/org/shares') {
      const admin = await requireAdmin(u.searchParams.get('userToken'));
      if (!admin) return sendJson(res, 403, { error: 'no_admin' });
      const shares = await db.listOrgShares(admin.org_id);
      const list = shares.map(s => ({
        shareId: s.id, name: s.name, kind: s.kind, status: s.status,
        opens: s.opens, viewers: s.viewers, ownerEmail: s.owner_email || '(匿名)',
        maxViewers: s.max_viewers, maxViews: s.max_views, durationSec: s.duration_sec,
        expiresAt: s.expires_at, accessCode: s.access_code, authMode: s.auth_mode, watermark: s.watermark,
        restrictions: { copy: !!s.disable_copy, print: !!s.disable_print, download: !!s.disable_download, screenshot: !!s.disable_screenshot },
        createdAt: s.created_at, link: `/viewer.html?share=${s.id}`
      }));
      return sendJson(res, 200, { shares: list });
    }
    // 成员列表
    if (req.method === 'GET' && p === '/api/org/members') {
      const admin = await requireAdmin(u.searchParams.get('userToken'));
      if (!admin) return sendJson(res, 403, { error: 'no_admin' });
      const members = await db.listOrgMembers(admin.org_id);
      return sendJson(res, 200, { members: members.map(m => ({
        id: m.id, email: m.email, role: m.role, createdAt: m.created_at
      })) });
    }
    // 生成邀请码
    if (req.method === 'POST' && p === '/api/org/invite') {
      const admin = await requireAdmin(u.searchParams.get('userToken'));
      if (!admin) return sendJson(res, 403, { error: 'no_admin' });
      const code = crypto.randomBytes(4).toString('hex');
      await db.createInvite({ code, orgId: admin.org_id, createdBy: admin.id, createdAt: nowMs() });
      await db.recordAudit(admin.id, 'create_invite', 'org', `code=${code}`);
      return sendJson(res, 200, { code });
    }

    // ---------- 超级管理员（全局） ----------
    // 存储占用统计
    if (req.method === 'GET' && p === '/api/super/stats') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const st = await db.statsStorage();
      return sendJson(res, 200, {
        totalBytes: st.totalBytes, totalFiles: st.totalFiles, byStatus: st.byStatus,
        orphanCount: st.orphanCount, orphanBytes: st.orphanBytes,
        topUsers: st.topUsers.map(x => ({ email: x.email, bytes: Number(x.bytes) || 0, shareCount: Number(x.share_count) || 0 })),
        topShares: st.topShares.map(x => ({ id: x.id, name: x.name, ownerEmail: x.owner_email || '(匿名)', size: Number(x.file_size) || 0 }))
      });
    }
    // 全部分享（超管可管理任意分享）
    if (req.method === 'GET' && p === '/api/super/shares') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const shares = await db.listAllShares();
      const list = shares.map(s => ({
        shareId: s.id, fileId: s.file_id, name: s.name, kind: s.kind, status: s.status,
        ownerEmail: s.owner_email || '(匿名)',
        opens: s.opens, viewers: s.viewers,
        maxViewers: s.max_viewers, maxViews: s.max_views, durationSec: s.duration_sec,
        expiresAt: s.expires_at, accessCode: s.access_code, authMode: s.auth_mode, watermark: s.watermark,
        restrictions: { copy: !!s.disable_copy, print: !!s.disable_print, download: !!s.disable_download, screenshot: !!s.disable_screenshot },
        createdAt: s.created_at, link: `/viewer.html?share=${s.id}`
      }));
      return sendJson(res, 200, { shares: list });
    }
    // 用户列表
    if (req.method === 'GET' && p === '/api/super/users') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const users = await db.listAllUsers();
      return sendJson(res, 200, { users: users.map(x => ({
        id: x.id, email: x.email, realName: x.real_name || '', role: x.role, isSuper: !!Number(x.is_super), disabled: !!Number(x.disabled),
        orgId: x.org_id, createdAt: Number(x.created_at), shareCount: Number(x.share_count) || 0, bytes: Number(x.bytes) || 0
      })) });
    }
    // 操作审计日志（支持筛选：动作 / 操作人 / 对象类型 / 时间范围 / 关键词）
    if (req.method === 'GET' && p === '/api/super/audit') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const action = (u.searchParams.get('action') || '').trim();
      const actor = (u.searchParams.get('actor') || '').trim().toLowerCase();
      const targetType = (u.searchParams.get('targetType') || '').trim();
      const q = (u.searchParams.get('q') || '').trim().toLowerCase();
      const from = Number(u.searchParams.get('from') || 0);
      const to = Number(u.searchParams.get('to') || 0);
      let logs = await db.listAudit(1000);
      if (action) logs = logs.filter(l => (l.action || '') === action);
      if (actor) logs = logs.filter(l => ((l.actor_email || '') + ' ' + (l.actor_real_name || '')).toLowerCase().includes(actor));
      if (targetType === 'user') logs = logs.filter(l => /_user$/.test(l.action || ''));
      else if (targetType === 'org') logs = logs.filter(l => (l.target || '') === 'org');
      else if (targetType === 'storage') logs = logs.filter(l => (l.target || '') === 'storage');
      else if (targetType === 'share') logs = logs.filter(l => !/_user$/.test(l.action || '') && (l.target || '') !== 'org' && (l.target || '') !== 'storage');
      if (from) logs = logs.filter(l => Number(l.created_at) >= from);
      if (to) logs = logs.filter(l => Number(l.created_at) <= to);
      if (q) logs = logs.filter(l => ((l.detail || '') + ' ' + (l.action || '') + ' ' + (l.actor_real_name || '') + ' ' + (l.actor_email || '')).toLowerCase().includes(q));
      logs = logs.slice(0, 200);
      return sendJson(res, 200, { logs: logs.map(l => ({
        actorId: l.actor_id, action: l.action, target: l.target, detail: l.detail, createdAt: Number(l.created_at),
        actorEmail: l.actor_email || '', actorRealName: l.actor_real_name || ''
      })) });
    }
    // 清理孤儿文件（已销毁/未分享文件），释放存储
    if (req.method === 'POST' && p === '/api/super/cleanup') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const orphans = await db.orphanFiles();
      let deleted = 0, freed = 0;
      for (const f of orphans) {
        await db.run('DELETE FROM shares WHERE file_id=?', [f.id]);
        try { await storage.delete(f.stored_name); } catch (e) { /* 已不存在 */ }
        if (f.preview_path) { try { await storage.delete(f.preview_path); } catch (e) {} }
        await db.deleteFileRow(f.id);
        deleted++; freed += Number(f.size) || 0;
      }
      await db.recordAudit(sup.id, 'cleanup', 'storage', `files=${deleted};bytes=${freed}`);
      return sendJson(res, 200, { ok: true, deleted, freed });
    }
    // 用户管理动作：disable / enable / role / super / delete
    const um = p.match(/^\/api\/super\/user\/([^/]+)\/(disable|enable|role|super|delete)$/);
    if (um && req.method === 'POST') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const targetId = um[1]; const action = um[2];
      if (targetId === sup.id) return sendJson(res, 400, { error: 'self_op', message: '不能对自己执行该操作' });
      const target = await db.getUser(targetId);
      if (!target) return sendJson(res, 404, { error: 'no_user' });
      if (action === 'disable') { await db.setUserDisabled(targetId, 1); await db.recordAudit(sup.id, 'disable_user', targetId, `email=${target.email}`); }
      else if (action === 'enable') { await db.setUserDisabled(targetId, 0); await db.recordAudit(sup.id, 'enable_user', targetId, `email=${target.email}`); }
      else if (action === 'role') {
        const b = JSON.parse(await readBody(req, 1 << 20));
        const role = b.role === 'admin' ? 'admin' : 'member';
        await db.setUserRole(targetId, role); await db.recordAudit(sup.id, 'set_role', targetId, `email=${target.email};role=${role}`);
      }
      else if (action === 'super') {
        const b = JSON.parse(await readBody(req, 1 << 20));
        await db.setUserSuper(targetId, b.super ? 1 : 0); await db.recordAudit(sup.id, 'set_super', targetId, `email=${target.email};super=${!!b.super}`);
      }
      else if (action === 'delete') {
        const shares = await db.listMySharesById(targetId);
        for (const sh of shares) {
          const f = await db.getFile(sh.file_id);
          if (f) {
            try { await storage.delete(f.stored_name); } catch (e) {}
            if (f.preview_path) { try { await storage.delete(f.preview_path); } catch (e) {} }
            await db.deleteFileRow(f.id);
          }
          await db.deleteShareRow(sh.id);
        }
        await db.deleteUser(targetId);
        await db.recordAudit(sup.id, 'delete_user', targetId, `email=${target.email};shares=${shares.length}`);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 超级管理员：门店(org)管理 ----------
    if (req.method === 'GET' && p === '/api/super/orgs') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const orgs = await db.listOrgsWithStats();
      return sendJson(res, 200, { orgs: orgs.map(o => ({
        id: o.id, name: o.name, domain: o.domain || '', createdAt: Number(o.created_at),
        memberCount: Number(o.member_count) || 0, managerEmail: o.manager_email || ''
      })) });
    }
    if (req.method === 'POST' && p === '/api/super/org') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const b = JSON.parse(await readBody(req, 1 << 20));
      const name = String(b.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name_required', message: '门店名称不能为空' });
      const id = uuid();
      await db.createOrg({ id, name, domain: '', createdAt: nowMs() });
      await db.recordAudit(sup.id, 'create_org', 'org', `id=${id};name=${name}`);
      return sendJson(res, 200, { ok: true, id, name });
    }
    // 门店成员列表（超管查看任意门店）
    const orgMembersM = p.match(/^\/api\/super\/org\/([^/]+)\/members$/);
    if (orgMembersM && req.method === 'GET') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const org = await db.getOrg(orgMembersM[1]);
      if (!org) return sendJson(res, 404, { error: 'no_org', message: '门店不存在' });
      const members = await db.listOrgMembers(orgMembersM[1]);
      return sendJson(res, 200, { members: members.map(m => ({
        id: m.id, email: m.email, realName: m.real_name || '', role: m.role, isSuper: !!Number(m.is_super), createdAt: Number(m.created_at)
      })) });
    }
    const orgM = p.match(/^\/api\/super\/org\/([^/]+)$/);
    if (orgM && (req.method === 'PUT' || req.method === 'DELETE')) {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const orgId = orgM[1];
      const org = await db.getOrg(orgId);
      if (!org) return sendJson(res, 404, { error: 'no_org', message: '门店不存在' });
      if (req.method === 'DELETE') {
        const members = await db.listOrgMembers(orgId);
        if (members && members.length) return sendJson(res, 409, { error: 'has_members', message: '该门店仍有成员，请先将成员移出或分配到其他门店' });
        await db.deleteOrg(orgId);
        await db.recordAudit(sup.id, 'delete_org', 'org', `id=${orgId};name=${org.name}`);
        return sendJson(res, 200, { ok: true });
      }
      const b = JSON.parse(await readBody(req, 1 << 20));
      const name = String(b.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'name_required', message: '门店名称不能为空' });
      await db.renameOrg(orgId, name);
      await db.recordAudit(sup.id, 'rename_org', 'org', `id=${orgId};name=${name}`);
      return sendJson(res, 200, { ok: true });
    }
    // 超管：将用户分配到门店并设置角色（orgId 为空表示移出门店）
    const userOrgM = p.match(/^\/api\/super\/user\/([^/]+)\/org$/);
    if (userOrgM && req.method === 'POST') {
      const sup = await requireSuper(u.searchParams.get('userToken'));
      if (!sup) return sendJson(res, 403, { error: 'no_super' });
      const targetId = userOrgM[1];
      if (targetId === sup.id) return sendJson(res, 400, { error: 'self_op', message: '不能对自己执行该操作' });
      const target = await db.getUser(targetId);
      if (!target) return sendJson(res, 404, { error: 'no_user', message: '用户不存在' });
      const b = JSON.parse(await readBody(req, 1 << 20));
      const orgId = String(b.orgId || '').trim();
      const role = b.role === 'admin' ? 'admin' : 'member';
      if (orgId) {
        const org = await db.getOrg(orgId);
        if (!org) return sendJson(res, 400, { error: 'invalid_org', message: '门店不存在' });
      }
      await db.updateUserOrg({ userId: targetId, orgId: orgId || '', role });
      await db.recordAudit(sup.id, 'set_org', targetId, `email=${target.email};orgId=${orgId};role=${role}`);
      return sendJson(res, 200, { ok: true });
    }
    // ---------- 店长：查看本店成员分享/日志明细 ----------
    const memberDetailM = p.match(/^\/api\/org\/members\/([^/]+)\/detail$/);
    if (memberDetailM && req.method === 'GET') {
      const admin = await requireAdmin(u.searchParams.get('userToken'));
      if (!admin) return sendJson(res, 403, { error: 'no_admin', message: '仅店长可查看' });
      const memberId = memberDetailM[1];
      const member = await db.getUser(memberId);
      if (!member || member.org_id !== admin.org_id) return sendJson(res, 404, { error: 'no_member', message: '成员不存在或非本店成员' });
      const memberShares = await db.listMySharesById(member.id);
      const shares = memberShares.map(s => ({
        shareId: s.id, name: s.name, kind: s.kind, status: s.status,
        opens: s.opens, viewers: s.viewers, expiresAt: s.expires_at, link: `/viewer.html?share=${s.id}`
      }));
      // 汇总该成员所有分享的访客与原始日志
      const viewerMap = {};
      const logs = [];
      for (const s of memberShares) {
        const vs = await db.getShareViewers(s.id);
        for (const v of vs) {
          const cur = viewerMap[v.viewerToken] || {
            viewerToken: v.viewerToken, opens: 0, durationSec: 0, lastAt: 0, firstAt: v.firstAt,
            device: v.device, os: v.os, browser: v.browser, ip: v.ip, country: v.country, region: v.region, city: v.city
          };
          cur.opens += (v.opens || 0);
          cur.durationSec += (v.durationSec || 0);
          if (Number(v.lastAt) > cur.lastAt) cur.lastAt = Number(v.lastAt);
          viewerMap[v.viewerToken] = cur;
        }
        const ls = await db.getShareLogs(s.id);
        for (const l of ls) logs.push({ shareId: s.id, shareName: s.name, event: l.event, progress: l.progress, ip: l.ip, createdAt: Number(l.created_at) });
      }
      const viewers = Object.values(viewerMap).sort((a, b) => b.lastAt - a.lastAt);
      return sendJson(res, 200, {
        member: { id: member.id, email: member.email, realName: member.real_name || '', role: member.role, isSuper: !!Number(member.is_super) },
        shares, viewers, logs
      });
    }

    return sendJson(res, 404, { error: 'route_not_found' });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'server_error', message: String(e && e.message) });
  }
});

db.init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`安全分享服务已启动: http://localhost:${PORT}（数据库：${db.driverType()}）`);
    });
  })
  .catch((err) => {
    console.error('数据库初始化失败，服务未启动：', err);
    process.exit(1);
  });
