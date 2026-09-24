'use strict';
// 统一异步仓储层：封装所有业务数据访问，屏蔽数据库方言差异。
// 通过 server/db_drivers.js 选择底层驱动（sqlite/postgres/mysql）。
const crypto = require('crypto');
const config = require('./config');
const { createDriver } = require('./db_drivers');
const track = require('./track');

function uuid() { return crypto.randomBytes(16).toString('hex'); }

let drv = null;
let ready = null;

// 初始化（在 server 启动前 await 调用）
async function init() {
  if (ready) return ready;
  ready = (async () => {
    drv = await createDriver();
  })();
  return ready;
}
async function end() { if (drv && drv.end) await drv.end(); }
function isReady() { return !!drv; }
function driverType() { return drv ? drv.type : null; }

// ---------- 用户与令牌 ----------
async function createUser({ id, email, salt, hash, openid = null, createdAt, orgId = null, role = 'member', supabaseId = null, isSuper = 0, realName = null }) {
  await drv.run('INSERT INTO users (id,email,password_hash,salt,wechat_openid,created_at,org_id,role,supabase_id,is_super,disabled,real_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, email, hash, salt, openid, createdAt, orgId || '', role, supabaseId || '', isSuper ? 1 : 0, 0, realName || '']);
}
async function countUsers() {
  const row = await drv.get('SELECT COUNT(*) AS c FROM users');
  return row ? Number(row.c) : 0;
}
async function findUserByEmail(email) {
  return drv.get('SELECT * FROM users WHERE email=?', [email]) || null;
}
async function findUserByOpenid(openid) {
  return drv.get('SELECT id FROM users WHERE wechat_openid=?', [openid]) || null;
}
async function getUser(id) {
  return drv.get('SELECT * FROM users WHERE id=?', [id]) || null;
}
async function getUserByEmail(email) {
  return findUserByEmail(email);
}
async function getUserBySupabaseId(sub) {
  if (!sub) return null;
  return drv.get('SELECT * FROM users WHERE supabase_id=?', [sub]) || null;
}
// 确保 Supabase 用户存在（首登自动建行 + 归属组织）。返回用户行或 { error }。
async function ensureUser({ sub, email, inviteCode, realName = null }) {
  const lowerEmail = String(email || '').toLowerCase();
  // 1) 优先按 supabase_id（sub）查：已绑定过的账号直接复用
  const bySub = await getUserBySupabaseId(sub);
  if (bySub) {
    // 已存在用户：若邮箱在超级管理员名单内且尚未标记，则同步提权。
    // 否则旧版已注册的老账号在新版上线后永远不会变成超级管理员。
    if (config.SUPER_ADMIN_EMAILS.includes(lowerEmail) && !bySub.is_super) {
      await setUserSuper(bySub.id, 1);
      const refreshed = await getUser(bySub.id);
      return refreshed || bySub;
    }
    return bySub;
  }
  // 2) 再按邮箱查：兼容“老账号（自研注册，supabase_id 为空）首次改用 Supabase 登录”的场景，
  //    避免用同一个邮箱重复建号触发 UNIQUE(email) 冲突导致 bootstrap 500。
  const byEmail = lowerEmail ? (await drv.get('SELECT * FROM users WHERE LOWER(email)=?', [lowerEmail]) || null) : null;
  if (byEmail) {
    // 补上 supabase_id，下次即可按 sub 命中；必要时同步提权
    await drv.run('UPDATE users SET supabase_id=? WHERE id=?', [sub || '', byEmail.id]);
    if (config.SUPER_ADMIN_EMAILS.includes(lowerEmail) && !byEmail.is_super) {
      await setUserSuper(byEmail.id, 1);
    }
    const refreshed = await getUser(byEmail.id);
    return refreshed || byEmail;
  }
  // 门店(org)由超级管理员在后台统一创建与分配；Supabase 登录仅在携带有效邀请码时加入指定门店，
  // 否则 org_id 为空（未入店），创建分享时会被网关拦截。不再按邮箱域名自动建组织。
  let orgId = null, role = 'member';
  if (inviteCode) {
    const inv = await getInvite(inviteCode);
    if (!inv) return { error: 'invalid_invite', message: '邀请码无效' };
    orgId = inv.org_id;
  }
  const id = uuid();
  const isSuper = (config.SUPER_ADMIN_EMAILS.includes(String(email || '').toLowerCase())) ? 1 : 0;
  await createUser({ id, email: email || '', salt: '', hash: '', openid: null, createdAt: Date.now(), orgId, role, supabaseId: sub, isSuper, realName });
  return getUser(id);
}
async function updateUserOrg({ userId, orgId, role }) {
  await drv.run('UPDATE users SET org_id=?, role=? WHERE id=?', [orgId || '', role, userId]);
}

// ---------- 组织 ----------
async function createOrg({ id, name, domain = '', createdAt }) {
  await drv.run('INSERT INTO orgs (id,name,domain,created_at) VALUES (?,?,?,?)', [id, name, domain || '', createdAt]);
}
async function getOrg(id) {
  return drv.get('SELECT * FROM orgs WHERE id=?', [id]) || null;
}
// 列出所有门店（仅公开字段），供登录后用户选择所属门店。
// 注意：旧的“按邮箱域名自动解析/创建门店”逻辑已移除，门店改由后台统一创建、用户自助选择。
async function listOrgsPublic() {
  return drv.all('SELECT id, name FROM orgs ORDER BY created_at ASC, name ASC') || [];
}
async function countOrgs() {
  const row = await drv.get('SELECT COUNT(*) AS c FROM orgs');
  return row ? Number(row.c) : 0;
}
async function listOrgShares(orgId) {
  return drv.all(`SELECT s.*,
      u.email AS owner_email,
      (SELECT COUNT(*) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS opens,
      (SELECT COUNT(DISTINCT l.viewer_token) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS viewers
    FROM shares s LEFT JOIN users u ON s.owner_id=u.id
    WHERE s.owner_id IN (SELECT id FROM users WHERE org_id=?)
    ORDER BY s.created_at DESC`, [orgId]);
}
async function listOrgMembers(orgId) {
  return drv.all('SELECT id, email, real_name, role, is_super, created_at FROM users WHERE org_id=? ORDER BY (role=\'admin\') DESC, created_at ASC', [orgId]);
}
// 门店重命名
async function renameOrg(id, name) { await drv.run('UPDATE orgs SET name=? WHERE id=?', [name, id]); }
// 删除门店（同时清理其邀请码；成员需先移出，由调用方校验）
async function deleteOrg(id) {
  await drv.run('DELETE FROM org_invites WHERE org_id=?', [id]);
  await drv.run('DELETE FROM orgs WHERE id=?', [id]);
}
// 超级管理员视图：列出全部门店及人数/店长
async function listOrgsWithStats() {
  return drv.all(`SELECT o.id, o.name, o.domain, o.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id) AS member_count,
      (SELECT u.email FROM users u WHERE u.org_id=o.id AND u.role='admin' LIMIT 1) AS manager_email
    FROM orgs o ORDER BY o.created_at ASC`);
}
async function createInvite({ code, orgId, createdBy, createdAt }) {
  await drv.run('INSERT INTO org_invites (code,org_id,created_by,created_at) VALUES (?,?,?,?)', [code, orgId, createdBy, createdAt]);
}
async function getInvite(code) {
  if (!code) return null;
  return drv.get('SELECT * FROM org_invites WHERE code=?', [code]) || null;
}
async function createUserToken({ token, userId, createdAt, expiresAt }) {
  await drv.run('INSERT INTO user_tokens (token,user_id,created_at,expires_at) VALUES (?,?,?,?)',
    [token, userId, createdAt, expiresAt]);
}
// 返回 { userId, expiresAt } 或 null（含过期判断）
async function getUserToken(token) {
  if (!token) return null;
  const row = await drv.get('SELECT user_id, expires_at FROM user_tokens WHERE token=?', [token]);
  if (!row) return null;
  if (row.expires_at && Date.now() > Number(row.expires_at)) return null;
  return { userId: row.user_id, expiresAt: Number(row.expires_at) || 0 };
}
async function getUserEmail(userId) {
  const row = await drv.get('SELECT email FROM users WHERE id=?', [userId]);
  return row ? row.email : null;
}
// 改密后废除该用户除 keepToken 外的其它会话令牌
async function revokeOtherTokens(userId, keepToken) {
  await drv.run('DELETE FROM user_tokens WHERE user_id=? AND token<>?', [userId, keepToken || '']);
}

// ---------- 微信状态机 ----------
async function createWechatState({ state, userId = null, openid = null, status = 'pending', createdAt, purpose, shareId = null, viewerToken, expiresAt }) {
  await drv.run('INSERT INTO wechat_states (state,user_id,openid,status,created_at,purpose,share_id,viewer_token,issued_token,access_token,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [state, userId, openid, status, createdAt, purpose, shareId, viewerToken, null, null, expiresAt]);
}
async function getWechatState(state) {
  return drv.get('SELECT * FROM wechat_states WHERE state=?', [state]) || null;
}
async function confirmWechatState({ userId, openid, status, state }) {
  await drv.run('UPDATE wechat_states SET user_id=?,openid=?,status=? WHERE state=?', [userId, openid, status, state]);
}
async function setWechatLoginToken({ token, state }) {
  await drv.run('UPDATE wechat_states SET issued_token=? WHERE state=?', [token, state]);
}
async function setWechatVerifyIssued({ accessToken, expiresIn, state }) {
  await drv.run('UPDATE wechat_states SET issued_token=?, access_token=? WHERE state=?', [accessToken, String(expiresIn), state]);
}

// ---------- 文件 ----------
async function createFile({ id, originalName, storedName, mime, size, kind, previewPath = null, createdAt }) {
  await drv.run('INSERT INTO files (id,original_name,stored_name,mime,size,kind,preview_path,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, originalName, storedName, mime, size, kind, previewPath || null, createdAt]);
}
async function getFile(id) {
  return drv.get('SELECT * FROM files WHERE id=?', [id]) || null;
}
// 替换文件：保持 file_id 不变（分享链接因此永远不变），仅更新存储名/类型/大小/预览。
async function replaceFileById(fileId, fields) {
  await drv.run('UPDATE files SET stored_name=?, mime=?, size=?, kind=?, preview_path=?, original_name=? WHERE id=?',
    [fields.storedName, fields.mime, fields.size, fields.kind, fields.previewPath || null, fields.originalName || '', fileId]);
}
// 重命名：仅改展示名（original_name），保持 file_id 不变（分享链接不变）。
async function renameFileById(fileId, name) {
  await drv.run('UPDATE files SET original_name=? WHERE id=?', [name, fileId]);
}
// 引用某文件的分享（用于权限校验与删除拦截）
async function listSharesByFile(fileId) {
  return drv.all(`SELECT s.id, s.name, s.owner_id, s.status, u.email AS owner_email
    FROM shares s LEFT JOIN users u ON s.owner_id=u.id WHERE s.file_id=? ORDER BY s.created_at DESC`, [fileId]);
}
async function countSharesByFile(fileId) {
  const row = await drv.get('SELECT COUNT(*) AS c FROM shares WHERE file_id=?', [fileId]);
  return row ? Number(row.c) : 0;
}
// 我的文件：通过“我创建的分享所引用的文件”反查（文件本身无 owner 字段，归属由分享决定）
async function listFilesForUser(userId) {
  return drv.all(`SELECT f.id, f.original_name AS name, f.stored_name, f.mime, f.size, f.kind, f.preview_path, f.created_at AS createdAt,
      (SELECT COUNT(*) FROM shares s WHERE s.file_id=f.id) AS share_count,
      (SELECT s.id FROM shares s WHERE s.file_id=f.id ORDER BY s.created_at DESC LIMIT 1) AS share_id,
      (SELECT s.name FROM shares s WHERE s.file_id=f.id ORDER BY s.created_at DESC LIMIT 1) AS share_name
    FROM files f WHERE f.id IN (SELECT file_id FROM shares WHERE owner_id=?) ORDER BY f.created_at DESC`, [userId]);
}
// 全部文件（超管）：含孤儿文件；owner 通过任意引用它的分享推断
async function listAllFiles() {
  return drv.all(`SELECT f.id, f.original_name AS name, f.stored_name, f.mime, f.size, f.kind, f.preview_path, f.created_at AS createdAt,
      (SELECT COUNT(*) FROM shares s WHERE s.file_id=f.id) AS share_count,
      (SELECT u.email FROM shares s JOIN users u ON s.owner_id=u.id WHERE s.file_id=f.id LIMIT 1) AS owner_email
    FROM files f ORDER BY f.created_at DESC`);
}

// ---------- 分享 ----------
async function createShare({ shareId, fileId, ownerId, ownerToken, name, kind, maxViewers, maxViews, durationSec, expiresAt, accessCode, authMode, selfDestruct, watermark, restrictions, extra, createdAt }) {
  const extraStr = extra ? JSON.stringify(extra) : '';
  await drv.run(`INSERT INTO shares
    (id,file_id,owner_id,owner_token,name,kind,status,max_viewers,max_views,duration_sec,expires_at,access_code,auth_mode,watermark,disable_copy,disable_print,disable_download,disable_screenshot,self_destruct,extra,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [shareId, fileId, ownerId, ownerToken, name, kind, 'active',
      maxViewers || 0, maxViews || 0, durationSec || 0,
      expiresAt || null, accessCode || null, authMode, watermark || '',
      restrictions.copy ? 1 : 0, restrictions.print ? 1 : 0, restrictions.download ? 1 : 0, restrictions.screenshot ? 1 : 0,
      selfDestruct ? 1 : 0,
      extraStr, createdAt, createdAt]);
}
async function getShare(id) {
  return drv.get('SELECT * FROM shares WHERE id=?', [id]) || null;
}
async function getShareMeta(id) {
  return drv.get(`SELECT s.id,s.name,s.kind,s.status,s.max_viewers,s.max_views,s.duration_sec,s.expires_at,s.access_code,s.auth_mode,s.watermark,s.disable_copy,s.disable_print,s.disable_download,s.disable_screenshot,s.self_destruct,s.extra,s.owner_id,
      f.preview_path
    FROM shares s LEFT JOIN files f ON s.file_id=f.id WHERE s.id=?`, [id]) || null;
}
async function setShareStatus(shareId, status, now) {
  await drv.run('UPDATE shares SET status=?, updated_at=? WHERE id=?', [status, now, shareId]);
}
// 水印字段兼容层：入参 watermark 可能是对象 {mode,text,dl}（新模型）或纯字符串（旧模型，按静态处理）。
// 统一落成 JSON 字符串存入 watermark 列；none/空则存空串。
function normWatermark(w) {
  if (!w) return '';
  if (typeof w !== 'object') {
    return w.length ? JSON.stringify({ mode: 'static', text: w, dl: false }) : '';
  }
  if (!w.mode || w.mode === 'none') return '';
  return JSON.stringify({ mode: w.mode, text: w.text || '', dl: !!w.dl });
}
async function updateShareSettings(shareId, s, now) {
  const am = (s.authMode === 'approve' || s.authMode === 'wechat') ? s.authMode : 'open';
  const extraStr = s.extra ? (typeof s.extra === 'string' ? s.extra : JSON.stringify(s.extra)) : '';
  await drv.run(`UPDATE shares SET max_viewers=?,max_views=?,duration_sec=?,expires_at=?,access_code=?,auth_mode=?,watermark=?,disable_copy=?,disable_print=?,disable_download=?,disable_screenshot=?,self_destruct=?,extra=?,updated_at=? WHERE id=?`,
    [Number(s.maxViewers) || 0, Number(s.maxViews) || 0, Number(s.durationSec) || 0, s.expiresAt ? Number(s.expiresAt) : null, s.accessCode || null, am, normWatermark(s.watermark), s.disableCopy ? 1 : 0, s.disablePrint ? 1 : 0, s.disableDownload ? 1 : 0, s.disableScreenshot ? 1 : 0, s.selfDestruct ? 1 : 0, extraStr, now, shareId]);
}

// ---------- 访问统计与审批 ----------
async function countOpens(shareId) {
  const row = await drv.get("SELECT COUNT(*) AS c FROM logs WHERE share_id=? AND event='open'", [shareId]);
  return row ? Number(row.c) : 0;
}
async function distinctViewers(shareId) {
  const rows = await drv.all("SELECT DISTINCT viewer_token FROM logs WHERE share_id=? AND event='open'", [shareId]);
  return rows.map(r => r.viewer_token);
}
// 单个账号的存储用量：聚合该账号所有分享引用的去重文件大小（字节）。
// 文件表无 owner 字段，故按「owner 的 shares 引用的 files」聚合；DISTINCT 避免同一文件被多分享引用时重复计入。
async function sumStorageForUser(userId) {
  const row = await drv.get(`SELECT COALESCE(SUM(f.size),0) AS used FROM files f WHERE f.id IN (SELECT DISTINCT file_id FROM shares WHERE owner_id=?)`, [userId]);
  return row ? Number(row.used) : 0;
}
async function getApproval(shareId, viewerToken) {
  return drv.get('SELECT * FROM approvals WHERE share_id=? AND viewer_token=?', [shareId, viewerToken]) || null;
}
async function touchApproval(shareId, viewerToken, now) {
  await drv.touchApproval(shareId, viewerToken, now);
}
async function upsertApproval(shareId, viewerToken, status, now) {
  await drv.upsertApproval(shareId, viewerToken, status, now, now);
}

// ---------- 会话与日志 ----------
async function createSession({ token, shareId, viewerToken, expiresAt, unlocked = 0 }) {
  await drv.run('INSERT INTO sessions (token,share_id,viewer_token,expires_at,unlocked) VALUES (?,?,?,?,?)', [token, shareId, viewerToken, expiresAt, unlocked ? 1 : 0]);
}
async function getSession(token) {
  return drv.get('SELECT * FROM sessions WHERE token=?', [token]) || null;
}
async function updateSessionUnlock(token, unlocked) {
  await drv.run('UPDATE sessions SET unlocked=? WHERE token=?', [unlocked ? 1 : 0, token]);
}
async function logOpen({ shareId, viewerToken, ip, ua, now }) {
  const { device, os, browser } = track.parseUa(ua);
  const id = uuid();
  await drv.run('INSERT INTO logs (id,share_id,viewer_token,ip,ua,event,progress,created_at,device,os,browser) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, shareId, viewerToken, ip || '', ua || '', 'open', '', now, device, os, browser]);
  // 异步补全地理信息（不阻塞主流程，失败降级）
  Promise.resolve().then(async () => {
    try {
      const geo = await track.geoIp(ip);
      if (geo.country || geo.region || geo.city) await updateLogGeo(id, geo);
    } catch (e) { /* 忽略 */ }
  });
  return id;
}
async function updateLogGeo(id, geo) {
  await drv.run('UPDATE logs SET country=?, region=?, city=? WHERE id=?',
    [geo.country || '', geo.region || '', geo.city || '', id]);
}
async function recordProgress({ shareId, viewerToken, ip, ua, event, progress, now }) {
  await drv.run('INSERT INTO logs (id,share_id,viewer_token,ip,ua,event,progress,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [uuid(), shareId, viewerToken, ip, ua, event || 'progress', String(progress || ''), now]);
}
async function getShareLogs(shareId) {
  return drv.all('SELECT viewer_token,ip,event,progress,created_at FROM logs WHERE share_id=? ORDER BY created_at DESC LIMIT 300', [shareId]);
}
// 按查看者聚合明细：首访/末访时间、打开次数、设备/系统/浏览器、地理位置、最后进度、阅读时长
async function getShareViewers(shareId) {
  const rows = await drv.all(`SELECT viewer_token,
      MIN(created_at) AS first_at, MAX(created_at) AS last_at,
      COUNT(*) AS events,
      SUM(CASE WHEN event='open' THEN 1 ELSE 0 END) AS opens,
      MAX(device) AS device, MAX(os) AS os, MAX(browser) AS browser,
      MAX(country) AS country, MAX(region) AS region, MAX(city) AS city, MAX(ip) AS ip
    FROM logs WHERE share_id=? GROUP BY viewer_token ORDER BY last_at DESC`, [shareId]);
  // 阅读时长：按事件时间排序，相邻间隔累加；单次间隔超过 GAP_CAP 视为离开/空闲，不再计入
  const GAP_CAP = 5 * 60 * 1000;
  // 最后进度：不能在 SQL 里 MAX(progress)（字符串比较，p2 会被误判小于 p10），
  // 改为应用层取每个 viewer 时间线上最后一条非空 progress（progress 按时间递增上报）
  const evs = await drv.all('SELECT viewer_token, created_at, progress FROM logs WHERE share_id=? ORDER BY created_at ASC', [shareId]);
  const byViewer = {};
  const lastProg = {};
  for (const e of evs) {
    (byViewer[e.viewer_token] || (byViewer[e.viewer_token] = [])).push(Number(e.created_at));
    if (e.progress !== null && e.progress !== undefined && String(e.progress) !== '') lastProg[e.viewer_token] = String(e.progress);
  }
  return rows.map(r => {
    const times = byViewer[r.viewer_token] || [];
    let dur = 0;
    for (let i = 1; i < times.length; i++) dur += Math.min(times[i] - times[i - 1], GAP_CAP);
    return {
      viewerToken: r.viewer_token,
      firstAt: Number(r.first_at), lastAt: Number(r.last_at),
      events: Number(r.events), opens: Number(r.opens),
      lastProgress: lastProg[r.viewer_token] || '',
      device: r.device || '未知', os: r.os || '未知', browser: r.browser || '未知',
      country: r.country || '', region: r.region || '', city: r.city || '',
      ip: r.ip || '',
      durationSec: Math.round(dur / 1000)
    };
  });
}
async function getPendingApprovals(shareId) {
  return drv.all("SELECT viewer_token,status,requested_at FROM approvals WHERE share_id=? AND status='pending'", [shareId]);
}

// ---------- 管理后台：我的分享（带统计子查询，跨方言通用 SQL）----------
async function listMySharesById(userId) {
  return drv.all(`SELECT s.*,
      (SELECT COUNT(*) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS opens,
      (SELECT COUNT(DISTINCT l.viewer_token) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS viewers
    FROM shares s WHERE s.owner_id=? ORDER BY s.created_at DESC`, [userId]);
}
async function listMySharesByOwnerToken(ownerToken) {
  return drv.all(`SELECT s.*,
      (SELECT COUNT(*) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS opens,
      (SELECT COUNT(DISTINCT l.viewer_token) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS viewers
    FROM shares s WHERE s.owner_token=? ORDER BY s.created_at DESC`, [ownerToken]);
}

// ---------- 超级管理员：全局视图 ----------
async function listAllShares() {
  return drv.all(`SELECT s.*, u.email AS owner_email, f.size AS file_size,
      (SELECT COUNT(*) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS opens,
      (SELECT COUNT(DISTINCT l.viewer_token) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS viewers
    FROM shares s LEFT JOIN users u ON s.owner_id=u.id LEFT JOIN files f ON s.file_id=f.id
    ORDER BY s.created_at DESC`);
}
async function listAllUsers() {
  return drv.all(`SELECT u.id, u.email, u.real_name, u.role, u.is_super, u.disabled, u.created_at, u.org_id,
      (SELECT COUNT(*) FROM shares s WHERE s.owner_id=u.id) AS share_count,
      (SELECT COALESCE(SUM(f.size),0) FROM shares s JOIN files f ON s.file_id=f.id WHERE s.owner_id=u.id) AS bytes
    FROM users u ORDER BY bytes DESC, u.created_at ASC`);
}
async function setUserDisabled(id, val) { await drv.run('UPDATE users SET disabled=? WHERE id=?', [val ? 1 : 0, id]); }
async function setUserRole(id, role) { await drv.run('UPDATE users SET role=? WHERE id=?', [role === 'admin' ? 'admin' : 'member', id]); }
async function setUserSuper(id, val) { await drv.run('UPDATE users SET is_super=? WHERE id=?', [val ? 1 : 0, id]); }
// 修改密码（由后端校验旧密码强度后调用，传入新的 salt/hash）
async function updateUserPassword(id, salt, hash) { await drv.run('UPDATE users SET salt=?, password_hash=? WHERE id=?', [salt, hash, id]); }
// 修改资料：真实姓名 + 默认分享参数（prefs 为 JSON 字符串）
async function updateUserProfile(id, { realName, prefs }) {
  const sets = [], args = [];
  if (realName !== undefined) { sets.push('real_name=?'); args.push(realName); }
  if (prefs !== undefined) { sets.push('prefs=?'); args.push(prefs || ''); }
  if (!sets.length) return;
  args.push(id);
  await drv.run('UPDATE users SET ' + sets.join(', ') + ' WHERE id=?', args);
}
async function deleteUser(id) {
  await drv.run('DELETE FROM user_tokens WHERE user_id=?', [id]);
  await drv.run('DELETE FROM users WHERE id=?', [id]);
}
// 存储占用统计：总量 / 分享数 / Top 用户 / Top 分享 / 可清理孤儿文件
async function statsStorage() {
  const totalBytes = await drv.get('SELECT COALESCE(SUM(size),0) AS t FROM files');
  const totalFiles = await drv.get('SELECT COUNT(*) AS c FROM files');
  const rows = await drv.all('SELECT status, COUNT(*) AS c FROM shares GROUP BY status');
  const byStatus = {}; rows.forEach(r => { byStatus[r.status] = Number(r.c); });
  const topUsers = await listAllUsers(); topUsers.splice(10);
  const topShares = await drv.all(`SELECT s.id, s.name, u.email AS owner_email, f.size AS file_size
      FROM shares s LEFT JOIN users u ON s.owner_id=u.id LEFT JOIN files f ON s.file_id=f.id
      ORDER BY f.size DESC LIMIT 10`);
  const orphan = await drv.get(`SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS b
      FROM files f WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.file_id=f.id AND s.status='active')`);
  return {
    totalBytes: Number(totalBytes.t), totalFiles: Number(totalFiles.c), byStatus,
    topUsers, topShares,
    orphanCount: Number(orphan.c), orphanBytes: Number(orphan.b)
  };
}
async function orphanFiles() {
  return drv.all(`SELECT f.id, f.stored_name, f.size FROM files f
      WHERE NOT EXISTS (SELECT 1 FROM shares s WHERE s.file_id=f.id AND s.status='active')`);
}
async function deleteFileRow(id) { await drv.run('DELETE FROM files WHERE id=?', [id]); }
async function deleteShareRow(id) { await drv.run('DELETE FROM shares WHERE id=?', [id]); }
// 过期自动清理：列出 expires_at 早于 beforeTs 的分享（永久分享 expires_at IS NULL 不参与）。
// 返回完整行，供 deleteShareDeep 使用（依赖 id / file_id）。
async function listExpiredShares(beforeTs) {
  return drv.all(`SELECT s.* FROM shares s WHERE s.expires_at IS NOT NULL AND s.expires_at < ?`, [beforeTs]);
}

// ---------- 操作审计日志 ----------
async function recordAudit(actorId, action, target, detail) {
  await drv.run('INSERT INTO audit_logs (id,actor_id,action,target,detail,created_at) VALUES (?,?,?,?,?,?)',
    [uuid(), actorId || '', action, target || '', detail || '', Date.now()]);
}
async function listAudit(limit = 200) {
  return drv.all(`SELECT a.actor_id, a.action, a.target, a.detail, a.created_at,
      u.email AS actor_email, u.real_name AS actor_real_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.created_at DESC LIMIT ?`, [limit]);
}
// 清理 N 天前的访问日志（心跳/进度事件占大头，不清理表会无限膨胀拖慢整体查询）
async function deleteOldLogs(days) {
  await drv.run('DELETE FROM logs WHERE created_at < ?', [Date.now() - days * 86400000]);
}

// ---------- 数据概览（超管全局 / 普通用户仅本人）----------
async function dashboardTotals(ownerId, isSuper) {
  let fileCount, shareCount, totalOpens, totalViewers;
  if (isSuper) {
    let r = await drv.get('SELECT COUNT(*) AS c FROM files'); fileCount = Number(r.c);
    r = await drv.get('SELECT COUNT(*) AS c FROM shares'); shareCount = Number(r.c);
    r = await drv.get("SELECT COUNT(*) AS c FROM logs WHERE event='open'"); totalOpens = Number(r.c);
    r = await drv.get("SELECT COUNT(DISTINCT viewer_token) AS c FROM logs WHERE event='open'"); totalViewers = Number(r.c);
  } else {
    let r = await drv.get('SELECT COUNT(DISTINCT file_id) AS c FROM shares WHERE owner_id=?', [ownerId]); fileCount = Number(r.c);
    r = await drv.get('SELECT COUNT(*) AS c FROM shares WHERE owner_id=?', [ownerId]); shareCount = Number(r.c);
    r = await drv.get("SELECT COUNT(*) AS c FROM logs l WHERE l.event='open' AND l.share_id IN (SELECT id FROM shares WHERE owner_id=?)", [ownerId]); totalOpens = Number(r.c);
    r = await drv.get("SELECT COUNT(DISTINCT l.viewer_token) AS c FROM logs l WHERE l.event='open' AND l.share_id IN (SELECT id FROM shares WHERE owner_id=?)", [ownerId]); totalViewers = Number(r.c);
  }
  return { fileCount, shareCount, totalOpens, totalViewers };
}
async function dashboardTopShares(ownerId, isSuper) {
  const where = isSuper ? '' : ' WHERE s.owner_id=?';
  const params = isSuper ? [] : [ownerId];
  return drv.all(`SELECT s.id, s.name, u.email AS owner_email,
      (SELECT COUNT(*) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS opens,
      (SELECT COUNT(DISTINCT l.viewer_token) FROM logs l WHERE l.share_id=s.id AND l.event='open') AS viewers
    FROM shares s LEFT JOIN users u ON s.owner_id=u.id ${where} ORDER BY opens DESC LIMIT 10`, params);
}
async function dashboardRecentViewers(ownerId, isSuper) {
  const where = isSuper ? "WHERE l.event='open'" : "WHERE l.event='open' AND s.owner_id=?";
  const params = isSuper ? [] : [ownerId];
  return drv.all(`SELECT l.viewer_token,
      MAX(l.created_at) AS last_at, COUNT(*) AS events,
      MAX(s.name) AS share_name, MAX(u.email) AS owner_email,
      MAX(l.country) AS country, MAX(l.region) AS region, MAX(l.city) AS city,
      MAX(l.ip) AS ip, MAX(l.device) AS device, MAX(l.os) AS os, MAX(l.browser) AS browser
    FROM logs l LEFT JOIN shares s ON l.share_id=s.id LEFT JOIN users u ON s.owner_id=u.id
    ${where} GROUP BY l.viewer_token ORDER BY last_at DESC LIMIT 20`, params);
}

// ---------- 全局参数（超管后台可改，DB 落库覆盖环境变量） ----------
// value 一律以 JSON 字符串存储，外部按类型解析。方言无关：先查后插/更。
async function getGlobalSetting(key) {
  const row = await drv.get('SELECT value FROM global_settings WHERE key=?', [key]);
  return row ? row.value : null;
}
async function getGlobalSettings() {
  const rows = await drv.all('SELECT key, value FROM global_settings');
  const out = {};
  for (const r of (rows || [])) out[r.key] = r.value;
  return out;
}
async function setGlobalSetting(key, value, updatedAt) {
  const existing = await drv.get('SELECT key FROM global_settings WHERE key=?', [key]);
  if (existing) await drv.run('UPDATE global_settings SET value=?, updated_at=? WHERE key=?', [value, updatedAt, key]);
  else await drv.run('INSERT INTO global_settings (key, value, updated_at) VALUES (?,?,?)', [key, value, updatedAt]);
}

module.exports = {
  init, end, isReady, driverType, uuid,
  // users/tokens
  createUser, findUserByEmail, findUserByOpenid, createUserToken, getUserToken, getUserEmail,
  getUser, getUserBySupabaseId, ensureUser, updateUserOrg, countUsers,
  // orgs
  createOrg, getOrg, listOrgsPublic, countOrgs, listOrgShares, listOrgMembers, renameOrg, deleteOrg, listOrgsWithStats, createInvite, getInvite,
  // wechat
  createWechatState, getWechatState, confirmWechatState, setWechatLoginToken, setWechatVerifyIssued,
  // files
  createFile, getFile, replaceFileById, renameFileById, listSharesByFile, countSharesByFile, listFilesForUser, listAllFiles,
  // shares
  createShare, getShare, getShareMeta, setShareStatus, updateShareSettings, listExpiredShares,
  // access control / approvals
  countOpens, distinctViewers, getApproval, touchApproval, upsertApproval, sumStorageForUser,
  // sessions / logs
  createSession, getSession, updateSessionUnlock, logOpen, recordProgress, getShareLogs, getShareViewers, getPendingApprovals,
  // admin
  listMySharesById, listMySharesByOwnerToken,
  // super admin
  listAllShares, listAllUsers, setUserDisabled, setUserRole, setUserSuper,
  updateUserPassword, updateUserProfile, revokeOtherTokens,
  getUserByEmail, deleteUser, statsStorage, orphanFiles, deleteFileRow, deleteShareRow, recordAudit, listAudit, deleteOldLogs,
  dashboardTotals, dashboardTopShares, dashboardRecentViewers,
  // 全局参数
  getGlobalSetting, getGlobalSettings, setGlobalSetting,
  // 直接透传底层（极少数方言无关操作）
  get: (sql, params) => drv.get(sql, params),
  all: (sql, params) => drv.all(sql, params),
  run: (sql, params) => drv.run(sql, params),
  UPLOAD_DIR: config.UPLOAD_DIR, DATA_DIR: config.DATA_DIR
};
