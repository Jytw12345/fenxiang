'use strict';
// 可插拔数据库驱动层：sqlite（默认）/ postgres / mysql
// 统一异步接口 run/get/all/exec，屏蔽方言差异（占位符、自增、upsert）。
const path = require('path');
const fs = require('fs');
const config = require('./config');

// 将 `?` 占位符转换为 PostgreSQL 的 $1/$2 ...
function toPg(sql, params) {
  let i = 0;
  const out = String(sql).replace(/\?/g, () => `$${++i}`);
  return { sql: out, params };
}

// 各方言建表语句（logs.id 统一为 TEXT uuid，避免自增方言差异）
const SCHEMA = {
  sqlite: [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, salt TEXT, wechat_openid TEXT, created_at INTEGER, org_id TEXT DEFAULT '', role TEXT DEFAULT 'member', supabase_id TEXT DEFAULT '', is_super INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0, real_name TEXT DEFAULT '', prefs TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS user_tokens (token TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER, expires_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, original_name TEXT, stored_name TEXT, mime TEXT, size INTEGER, kind TEXT, preview_path TEXT DEFAULT NULL, created_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, file_id TEXT, owner_id TEXT, owner_token TEXT, name TEXT, kind TEXT, status TEXT DEFAULT 'active', max_viewers INTEGER DEFAULT 0, max_views INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 0, expires_at INTEGER, access_code TEXT, auth_mode TEXT DEFAULT 'open', watermark TEXT DEFAULT '', disable_copy INTEGER DEFAULT 1, disable_print INTEGER DEFAULT 1, disable_download INTEGER DEFAULT 1, disable_screenshot INTEGER DEFAULT 0, extra TEXT DEFAULT '', created_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, share_id TEXT, viewer_token TEXT, ip TEXT, ua TEXT, event TEXT, progress TEXT, created_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS approvals (share_id TEXT, viewer_token TEXT, status TEXT DEFAULT 'pending', requested_at INTEGER, resolved_at INTEGER, PRIMARY KEY (share_id, viewer_token))`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, share_id TEXT, viewer_token TEXT, expires_at INTEGER, unlocked INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS wechat_states (state TEXT PRIMARY KEY, user_id TEXT, openid TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, purpose TEXT, share_id TEXT, viewer_token TEXT, issued_token TEXT, access_token TEXT, expires_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_logs_share ON logs(share_id)`,
    `CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id)`,
    `CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT, domain TEXT, created_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS org_invites (code TEXT PRIMARY KEY, org_id TEXT, created_by TEXT, created_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_invites_org ON org_invites(org_id)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT, target TEXT, detail TEXT, created_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`
  ],
  postgres: [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, salt TEXT, wechat_openid TEXT, created_at BIGINT, org_id TEXT DEFAULT '', role TEXT DEFAULT 'member', supabase_id TEXT DEFAULT '', is_super INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0, real_name TEXT DEFAULT '', prefs TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS user_tokens (token TEXT PRIMARY KEY, user_id TEXT, created_at BIGINT, expires_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, original_name TEXT, stored_name TEXT, mime TEXT, size BIGINT, kind TEXT, preview_path TEXT DEFAULT NULL, created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, file_id TEXT, owner_id TEXT, owner_token TEXT, name TEXT, kind TEXT, status TEXT DEFAULT 'active', max_viewers INTEGER DEFAULT 0, max_views INTEGER DEFAULT 0, duration_sec INTEGER DEFAULT 0, expires_at BIGINT, access_code TEXT, auth_mode TEXT DEFAULT 'open', watermark TEXT DEFAULT '', disable_copy INTEGER DEFAULT 1, disable_print INTEGER DEFAULT 1, disable_download INTEGER DEFAULT 1, disable_screenshot INTEGER DEFAULT 0, extra TEXT DEFAULT '', created_at BIGINT, updated_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, share_id TEXT, viewer_token TEXT, ip TEXT, ua TEXT, event TEXT, progress TEXT, created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS approvals (share_id TEXT, viewer_token TEXT, status TEXT DEFAULT 'pending', requested_at BIGINT, resolved_at BIGINT, PRIMARY KEY (share_id, viewer_token))`,
    `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, share_id TEXT, viewer_token TEXT, expires_at BIGINT, unlocked INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS wechat_states (state TEXT PRIMARY KEY, user_id TEXT, openid TEXT, status TEXT DEFAULT 'pending', created_at BIGINT, purpose TEXT, share_id TEXT, viewer_token TEXT, issued_token TEXT, access_token TEXT, expires_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_logs_share ON logs(share_id)`,
    `CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id)`,
    `CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT, domain TEXT, created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS org_invites (code TEXT PRIMARY KEY, org_id TEXT, created_by TEXT, created_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_invites_org ON org_invites(org_id)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT, target TEXT, detail TEXT, created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT, updated_at BIGINT)`
  ],
  mysql: [
    `CREATE TABLE IF NOT EXISTS users (id VARCHAR(64) PRIMARY KEY, email VARCHAR(255) UNIQUE, password_hash TEXT, salt TEXT, wechat_openid TEXT, created_at BIGINT, org_id VARCHAR(64) DEFAULT '', role VARCHAR(16) DEFAULT 'member', supabase_id VARCHAR(64) DEFAULT '', is_super INT DEFAULT 0, disabled INT DEFAULT 0, real_name TEXT DEFAULT '', prefs TEXT DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS user_tokens (token VARCHAR(128) PRIMARY KEY, user_id VARCHAR(64), created_at BIGINT, expires_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS files (id VARCHAR(64) PRIMARY KEY, original_name TEXT, stored_name TEXT, mime TEXT, size BIGINT, kind TEXT, preview_path TEXT, created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS shares (id VARCHAR(64) PRIMARY KEY, file_id VARCHAR(64), owner_id VARCHAR(64), owner_token VARCHAR(64), name TEXT, kind TEXT, status VARCHAR(16) DEFAULT 'active', max_viewers INT DEFAULT 0, max_views INT DEFAULT 0, duration_sec INT DEFAULT 0, expires_at BIGINT, access_code TEXT, auth_mode VARCHAR(16) DEFAULT 'open', watermark TEXT, disable_copy INT DEFAULT 1, disable_print INT DEFAULT 1, disable_download INT DEFAULT 1, disable_screenshot INT DEFAULT 0, extra TEXT, created_at BIGINT, updated_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS logs (id VARCHAR(64) PRIMARY KEY, share_id VARCHAR(64), viewer_token TEXT, ip TEXT, ua TEXT, event TEXT, progress TEXT, created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS approvals (share_id VARCHAR(64), viewer_token TEXT, status VARCHAR(16) DEFAULT 'pending', requested_at BIGINT, resolved_at BIGINT, PRIMARY KEY (share_id, viewer_token))`,
    `CREATE TABLE IF NOT EXISTS sessions (token VARCHAR(128) PRIMARY KEY, share_id VARCHAR(64), viewer_token TEXT, expires_at BIGINT, unlocked INT DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS wechat_states (state VARCHAR(64) PRIMARY KEY, user_id VARCHAR(64), openid TEXT, status VARCHAR(16) DEFAULT 'pending', created_at BIGINT, purpose TEXT, share_id VARCHAR(64), viewer_token TEXT, issued_token TEXT, access_token TEXT, expires_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_logs_share ON logs(share_id)`,
    `CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id)`,
    `CREATE TABLE IF NOT EXISTS orgs (id VARCHAR(64) PRIMARY KEY, name TEXT, domain VARCHAR(255), created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS org_invites (code VARCHAR(32) PRIMARY KEY, org_id VARCHAR(64), created_by VARCHAR(64), created_at BIGINT)`,
    `CREATE INDEX IF NOT EXISTS idx_invites_org ON org_invites(org_id)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id VARCHAR(64) PRIMARY KEY, actor_id TEXT, action TEXT, target TEXT, detail TEXT, created_at BIGINT)`,
    `CREATE TABLE IF NOT EXISTS global_settings (key VARCHAR(64) PRIMARY KEY, value TEXT, updated_at BIGINT)`
  ]
};

// ---------- 各底层驱动 ----------
function sqliteDriver() {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(config.DATA_DIR, 'safe_share5.db');
  if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE;'); // 避免 WAL 残留导致只读锁
  db.exec('PRAGMA busy_timeout = 5000;');   // 并发写入时等待而非立即报 SQLITE_BUSY
  return {
    type: 'sqlite',
    async run(sql, params = []) { const r = db.prepare(sql).run(...params); return { lastID: r.lastInsertRowid, changes: r.changes }; },
    async get(sql, params = []) { return db.prepare(sql).get(...params); },
    async all(sql, params = []) { return db.prepare(sql).all(...params); },
    async exec(sql) { db.exec(sql); },
    async end() { try { db.close(); } catch (e) {} }
  };
}

async function pgDriver() {
  let pg;
  try { pg = require('pg'); }
  catch (e) { throw new Error('DB_TYPE=postgres 需要 pg 驱动，请在 Docker 构建中安装（optionalDependencies 已包含）：' + e.message); }
  // 统一 BIGINT(INT8, OID=20) 的返回类型为 Number：
  // node-postgres 默认把 INT8 解析成「字符串」，前端 new Date("1757...") 会得到 Invalid Date
  // （本地 sqlite/mysql 返回数字，故该问题只在 postgres/Supabase 环境暴露）。
  // 本项目 BIGINT 只用于毫秒时间戳与文件字节数，均远小于 2^53，转 Number 无精度风险。
  try { pg.types.setTypeParser(20, v => (v == null ? v : Number(v))); } catch (e) {}
  const { Pool } = pg;
  const pool = new Pool(config.DB.config);
  return {
    type: 'postgres',
    async run(sql, params = []) { const c = toPg(sql, params); const r = await pool.query(c.sql, c.params); return { lastID: (r.rows[0] && r.rows[0].id) || 0, changes: r.rowCount || 0 }; },
    async get(sql, params = []) { const c = toPg(sql, params); const r = await pool.query(c.sql, c.params); return r.rows[0]; },
    async all(sql, params = []) { const c = toPg(sql, params); const r = await pool.query(c.sql, c.params); return r.rows; },
    async exec(sql) { await pool.query(sql); },
    async end() { await pool.end(); }
  };
}

async function mysqlDriver() {
  let mysql;
  try { mysql = require('mysql2/promise'); }
  catch (e) { throw new Error('DB_TYPE=mysql 需要 mysql2 驱动，请在 Docker 构建中安装（optionalDependencies 已包含）：' + e.message); }
  const pool = mysql.createPool(config.DB.config);
  return {
    type: 'mysql',
    async run(sql, params = []) { const [r] = await pool.query(sql, params); return { lastID: r.insertId, changes: r.affectedRows }; },
    async get(sql, params = []) { const [rows] = await pool.query(sql, params); return rows[0]; },
    async all(sql, params = []) { const [rows] = await pool.query(sql, params); return rows; },
    async exec(sql) { await pool.query(sql); },
    async end() { await pool.end(); }
  };
}

// approvals 的方言化 upsert / insert-ignore（复合主键 share_id,viewer_token）
function approvalSql(type) {
  if (type === 'mysql') {
    return {
      upsert: `INSERT INTO approvals (share_id,viewer_token,status,requested_at,resolved_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status), resolved_at=VALUES(resolved_at)`,
      touch: `INSERT IGNORE INTO approvals (share_id,viewer_token,status,requested_at) VALUES (?,?,?,?)`
    };
  }
  if (type === 'postgres') {
    return {
      upsert: `INSERT INTO approvals (share_id,viewer_token,status,requested_at,resolved_at) VALUES (?,?,?,?,?) ON CONFLICT (share_id,viewer_token) DO UPDATE SET status=EXCLUDED.status, resolved_at=EXCLUDED.resolved_at`,
      touch: `INSERT INTO approvals (share_id,viewer_token,status,requested_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`
    };
  }
  // sqlite
  return {
    upsert: `INSERT INTO approvals (share_id,viewer_token,status,requested_at,resolved_at) VALUES (?,?,?,?,?) ON CONFLICT(share_id,viewer_token) DO UPDATE SET status=excluded.status, resolved_at=excluded.resolved_at`,
    touch: `INSERT OR IGNORE INTO approvals (share_id,viewer_token,status,requested_at) VALUES (?,?,?,?)`
  };
}

// ---------- Supabase / PostgREST 加固（仅当检测到 Supabase 角色时执行） ----------
// 背景：Supabase 把 public schema 暴露为 REST API，并默认给 anon / authenticated 授予
// public 全部表的读写权限。本项目业务表由服务端直连（DATABASE_URL）创建，若不开 RLS，
// 任何人拿前端公开的 anon key 就能读写全库（对应告警 rls_disabled_in_public /
// sensitive_columns_exposed）。本项目前端只用 supabase-js 做登录（走 /auth/v1，不碰表），
// 所有表访问都在服务端 → 可安全地「public 全表开 RLS（无策略=全拒）+ 收回 anon/authenticated 权限」。
// 直连角色即建表者（owner），owner 不受 RLS 约束（未用 FORCE ROW LEVEL SECURITY），故应用不受影响。
// 幂等，可重复执行；同步版本见 server/harden_public_rls.sql。
const HARDEN_STMTS = [
  `DO $$ DECLARE t record; BEGIN
     FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
       EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
     END LOOP;
   END $$`,
  `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated`,
  `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated`
];
async function hardenPostgrestAccess(drv) {
  try {
    const row = await drv.get(`SELECT 1 AS ok FROM pg_roles WHERE rolname = 'anon'`);
    if (!row) return; // 普通 Postgres（自建），没有 anon/authenticated 角色，无需处理
  } catch (e) { return; }
  for (const stmt of HARDEN_STMTS) {
    try { await drv.exec(stmt); }
    catch (e) { console.warn('[db] RLS 加固语句失败（已跳过，不影响启动）:', e.message); }
  }
  console.log('[db] 已加固 public：全部业务表开启 RLS，并收回 anon/authenticated 的 REST 访问权限');
}

// 创建并初始化驱动
async function createDriver() {
  const type = config.DB.TYPE;
  let drv;
  if (type === 'postgres') drv = await pgDriver();
  else if (type === 'mysql') drv = await mysqlDriver();
  else drv = sqliteDriver();

  const schema = SCHEMA[type] || SCHEMA.sqlite;
  for (const stmt of schema) { await drv.exec(stmt); }

  // 兼容已存在的旧库：为 users 补齐 org_id / role 列（新列已含默认值，失败即视为已存在）
  const userCols = ['ALTER TABLE users ADD COLUMN org_id TEXT DEFAULT \'\'', 'ALTER TABLE users ADD COLUMN role TEXT DEFAULT \'member\''];
  for (const alt of userCols) { try { await drv.exec(alt); } catch (e) { /* 列已存在，忽略 */ } }

  // 兼容旧库：为 users 补齐 supabase_id 列（Supabase 身份体系映射）
  try { await drv.exec('ALTER TABLE users ADD COLUMN supabase_id TEXT DEFAULT \'\''); } catch (e) { /* 列已存在，忽略 */ }

  // 兼容旧库：为 files 补齐 preview_path 列（源文件预览能力）
  try { await drv.exec('ALTER TABLE files ADD COLUMN preview_path TEXT DEFAULT NULL'); } catch (e) { /* 列已存在，忽略 */ }

  // 兼容旧库：为 users 补齐 is_super / disabled 列（超级管理员体系）
  try { await drv.exec('ALTER TABLE users ADD COLUMN is_super INTEGER DEFAULT 0'); } catch (e) { /* 列已存在，忽略 */ }
  try { await drv.exec('ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0'); } catch (e) { /* 列已存在，忽略 */ }

  // 兼容旧库：为 users 补齐 real_name 列（真实姓名，注册必填）
  try { await drv.exec('ALTER TABLE users ADD COLUMN real_name TEXT DEFAULT \'\''); } catch (e) { /* 列已存在，忽略 */ }

  // 兼容旧库：为 shares 补齐 extra 列（类型化权限，如文档预览页数限制）
  try { await drv.exec('ALTER TABLE shares ADD COLUMN extra TEXT DEFAULT \'\''); } catch (e) { /* 列已存在，忽略 */ }

  // 兼容旧库：为 users 补齐 prefs 列（设置：默认分享参数等，JSON 字符串）
  try { await drv.exec('ALTER TABLE users ADD COLUMN prefs TEXT DEFAULT \'\''); } catch (e) { /* 列已存在，忽略 */ }

  // 兼容旧库：为 logs 补齐查看者明细列（设备/系统/浏览器/地理位置）
  for (const col of ['device', 'os', 'browser', 'country', 'region', 'city']) {
    try { await drv.exec(`ALTER TABLE logs ADD COLUMN ${col} TEXT DEFAULT ''`); } catch (e) { /* 列已存在，忽略 */ }
  }

  // 兼容旧库：为 sessions 补齐 unlocked 列（后续内容解锁标记）
  try { await drv.exec('ALTER TABLE sessions ADD COLUMN unlocked INTEGER DEFAULT 0'); } catch (e) { /* 列已存在，忽略 */ }

  // Supabase：关闭 PostgREST 对业务表的匿名读写（告警 rls_disabled_in_public 修复）
  if (type === 'postgres') await hardenPostgrestAccess(drv);

  const a = approvalSql(type);
  drv.upsertApproval = (shareId, viewerToken, status, requestedAt, resolvedAt) =>
    drv.run(a.upsert, [shareId, viewerToken, status, requestedAt, resolvedAt]);
  drv.touchApproval = (shareId, viewerToken, requestedAt) =>
    drv.run(a.touch, [shareId, viewerToken, 'pending', requestedAt]);

  console.log(`[db] 使用数据库驱动: ${drv.type}`);
  return drv;
}

module.exports = { createDriver, toPg, SCHEMA };
