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
async function createUser({ id, email, salt, hash, openid = null, createdAt, orgId = null, role = 'member', supabaseId = null, isSuper = 0 }) {
  await drv.run('INSERT INTO users (id,email,password_hash,salt,wechat_openid,created_at,org_id,role,supabase_id,is_super,disabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, email, hash, salt, openid, createdAt, orgId || '', role, supabaseId || '', isSuper ? 1 : 0, 0]);
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
async function ensureUser({ sub, email, inviteCode }) {
  const exist = await getUserBySupabaseId(sub);
  if (exist) {
    // 已存在用户：若邮箱在超级管理员名单内且尚未标记，则同步提权。
    // 否则旧版已注册的老账号在新版上线后永远不会变成超级管理员。
    if (config.SUPER_ADMIN_EMAILS.includes(String(email || '').toLowerCase()) && !exist.is_super) {
      await setUserSuper(exist.id, 1);
      const refreshed = await getUser(exist.id);
      return refreshed || exist;
    }
    return exist;
  }
  const domain = (String(email || '').split('@')[1] || '').toLowerCase();
  let orgId = null, role = 'member';
  if (inviteCode) {
    const inv = await getInvite(inviteCode);
    if (!inv) return { error: 'invalid_invite', message: '邀请码无效' };
    orgId = inv.org_id;
  } else if (domain) {
    const org = await getOrgByDomain(domain);
    if (org) orgId = org.id;
  }
  if (!orgId) {
    if (config.REGISTER_DOMAIN) {
      if (domain !== config.REGISTER_DOMAIN) return { error: 'domain_blocked', message: `仅限 ${config.REGISTER_DOMAIN} 邮箱注册` };
      let org = await getOrgByDomain(config.REGISTER_DOMAIN);
      if (!org) { const oid = uuid(); await createOrg({ id: oid, name: config.REGISTER_DOMAIN, domain: config.REGISTER_DOMAIN, createdAt: Date.now() }); orgId = oid; }
      else orgId = org.id;
      role = 'admin';
    } else {
      const oid = uuid(); await createOrg({ id: oid, name: domain || '我的组织', domain, createdAt: Date.now() }); orgId = oid; role = 'admin';
    }
  }
  const id = uuid();
  const isSuper = (config.SUPER_ADMIN_EMAILS.includes(String(email || '').toLowerCase())) ? 1 : 0;
  await createUser({ id, email: email || '', salt: '', hash: '', openid: null, createdAt: Date.now(), orgId, role, supabaseId: sub, isSuper });
  return getUser(id);
}
async function updateUserOrg({ userId, orgId, role }) {
  await drv.run('UPDATE users SET org_id=?, role=? WHERE id=?', [orgId || '', role, userId]);
}

// ---------- 组织 ----------
async function createOrg({ id, name, domain, createdAt }) {
  await drv.run('INSERT INTO orgs (id,name,domain,created_at) VALUES (?,?,?,?)', [id, name, domain || '', createdAt]);
}
async function getOrg(id) {
  return drv.get('SELECT * FROM orgs WHERE id=?', [id]) || null;
}
async function getOrgByDomain(domain) {
  if (!domain) return null;
  return drv.get('SELECT * FROM orgs WHERE domain=?', [domain]) || null;
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
  return drv.all('SELECT id, email, role, created_at FROM users WHERE org_id=? ORDER BY created_at ASC', [orgId]);
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

// ---------- 分享 ----------
async function createShare({ shareId, fileId, ownerId, ownerToken, name, kind, maxViewers, maxViews, durationSec, expiresAt, accessCode, authMode, watermark, restrictions, createdAt }) {
  await drv.run(`INSERT INTO shares
    (id,file_id,owner_id,owner_token,name,kind,status,max_viewers,max_views,duration_sec,expires_at,access_code,auth_mode,watermark,disable_copy,disable_print,disable_download,disable_screenshot,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [shareId, fileId, ownerId, ownerToken, name, kind, 'active',
      maxViewers || 0, maxViews || 0, durationSec || 0,
      expiresAt || null, accessCode || null, authMode, watermark || '',
      restrictions.copy ? 1 : 0, restrictions.print ? 1 : 0, restrictions.download ? 1 : 0, restrictions.screenshot ? 1 : 0,
      createdAt, createdAt]);
}
async function getShare(id) {
  return drv.get('SELECT * FROM shares WHERE id=?', [id]) || null;
}
async function getShareMeta(id) {
  return drv.get(`SELECT s.id,s.name,s.kind,s.status,s.max_viewers,s.max_views,s.duration_sec,s.expires_at,s.access_code,s.auth_mode,s.watermark,s.disable_copy,s.disable_print,s.disable_download,s.disable_screenshot,
      f.preview_path
    FROM shares s LEFT JOIN files f ON s.file_id=f.id WHERE s.id=?`, [id]) || null;
}
async function setShareStatus(shareId, status, now) {
  await drv.run('UPDATE shares SET status=?, updated_at=? WHERE id=?', [status, now, shareId]);
}
async function updateShareSettings(shareId, s, now) {
  const am = (s.authMode === 'approve' || s.authMode === 'wechat') ? s.authMode : 'open';
  await drv.run(`UPDATE shares SET max_viewers=?,max_views=?,duration_sec=?,expires_at=?,access_code=?,auth_mode=?,watermark=?,disable_copy=?,disable_print=?,disable_download=?,disable_screenshot=?,updated_at=? WHERE id=?`,
    [Number(s.maxViewers) || 0, Number(s.maxViews) || 0, Number(s.durationSec) || 0, s.expiresAt ? Number(s.expiresAt) : null, s.accessCode || null, am, s.watermark || '', s.disableCopy ? 1 : 0, s.disablePrint ? 1 : 0, s.disableDownload ? 1 : 0, s.disableScreenshot ? 1 : 0, now, shareId]);
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
async function createSession({ token, shareId, viewerToken, expiresAt }) {
  await drv.run('INSERT INTO sessions (token,share_id,viewer_token,expires_at) VALUES (?,?,?,?)', [token, shareId, viewerToken, expiresAt]);
}
async function getSession(token) {
  return drv.get('SELECT * FROM sessions WHERE token=?', [token]) || null;
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
// 按查看者聚合明细：首访/末访时间、打开次数、设备/系统/浏览器、地理位置、最后进度
async function getShareViewers(shareId) {
  const rows = await drv.all(`SELECT viewer_token,
      MIN(created_at) AS first_at, MAX(created_at) AS last_at,
      COUNT(*) AS events,
      SUM(CASE WHEN event='open' THEN 1 ELSE 0 END) AS opens,
      MAX(progress) AS last_progress,
      MAX(device) AS device, MAX(os) AS os, MAX(browser) AS browser,
      MAX(country) AS country, MAX(region) AS region, MAX(city) AS city, MAX(ip) AS ip
    FROM logs WHERE share_id=? GROUP BY viewer_token ORDER BY last_at DESC`, [shareId]);
  return rows.map(r => ({
    viewerToken: r.viewer_token,
    firstAt: Number(r.first_at), lastAt: Number(r.last_at),
    events: Number(r.events), opens: Number(r.opens),
    lastProgress: r.last_progress || '',
    device: r.device || '未知', os: r.os || '未知', browser: r.browser || '未知',
    country: r.country || '', region: r.region || '', city: r.city || '',
    ip: r.ip || ''
  }));
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
  return drv.all(`SELECT u.id, u.email, u.role, u.is_super, u.disabled, u.created_at, u.org_id,
      (SELECT COUNT(*) FROM shares s WHERE s.owner_id=u.id) AS share_count,
      (SELECT COALESCE(SUM(f.size),0) FROM shares s JOIN files f ON s.file_id=f.id WHERE s.owner_id=u.id) AS bytes
    FROM users u ORDER BY bytes DESC, u.created_at ASC`);
}
async function setUserDisabled(id, val) { await drv.run('UPDATE users SET disabled=? WHERE id=?', [val ? 1 : 0, id]); }
async function setUserRole(id, role) { await drv.run('UPDATE users SET role=? WHERE id=?', [role === 'admin' ? 'admin' : 'member', id]); }
async function setUserSuper(id, val) { await drv.run('UPDATE users SET is_super=? WHERE id=?', [val ? 1 : 0, id]); }
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

// ---------- 操作审计日志 ----------
async function recordAudit(actorId, action, target, detail) {
  await drv.run('INSERT INTO audit_logs (id,actor_id,action,target,detail,created_at) VALUES (?,?,?,?,?,?)',
    [uuid(), actorId || '', action, target || '', detail || '', Date.now()]);
}
async function listAudit(limit = 200) {
  return drv.all('SELECT actor_id, action, target, detail, created_at FROM audit_logs ORDER BY created_at DESC LIMIT ?', [limit]);
}

module.exports = {
  init, end, isReady, driverType, uuid,
  // users/tokens
  createUser, findUserByEmail, findUserByOpenid, createUserToken, getUserToken, getUserEmail,
  getUser, getUserBySupabaseId, ensureUser, updateUserOrg, countUsers,
  // orgs
  createOrg, getOrg, getOrgByDomain, countOrgs, listOrgShares, listOrgMembers, createInvite, getInvite,
  // wechat
  createWechatState, getWechatState, confirmWechatState, setWechatLoginToken, setWechatVerifyIssued,
  // files
  createFile, getFile,
  // shares
  createShare, getShare, getShareMeta, setShareStatus, updateShareSettings,
  // access control / approvals
  countOpens, distinctViewers, getApproval, touchApproval, upsertApproval,
  // sessions / logs
  createSession, getSession, logOpen, recordProgress, getShareLogs, getShareViewers, getPendingApprovals,
  // admin
  listMySharesById, listMySharesByOwnerToken,
  // super admin
  listAllShares, listAllUsers, setUserDisabled, setUserRole, setUserSuper,
  getUserByEmail, deleteUser, statsStorage, orphanFiles, deleteFileRow, deleteShareRow, recordAudit, listAudit,
  // 直接透传底层（极少数方言无关操作）
  get: (sql, params) => drv.get(sql, params),
  all: (sql, params) => drv.all(sql, params),
  run: (sql, params) => drv.run(sql, params),
  UPLOAD_DIR: config.UPLOAD_DIR, DATA_DIR: config.DATA_DIR
};
