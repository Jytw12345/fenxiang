'use strict';
// 集中管理环境变量配置（部署到自有服务器时通过 .env 或系统环境变量注入）
const path = require('path');

// 零依赖读取项目根目录 .env（若存在），仅补充尚未设置的变量，不覆盖已设置的环境变量。
// 这样本地 `node server/index.js` 也能直接吃 .env，无需手动 export。
(function loadDotEnv() {
  try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const k = m[1], v = m[2].replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) { /* .env 可选，缺失不影响运行 */ }
})();

function str(v, def) { return (v === undefined || v === null || v === '') ? def : String(v); }

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR: str(process.env.DATA_DIR, path.join(__dirname, '..', 'data')),
  UPLOAD_DIR: str(process.env.UPLOAD_DIR, path.join(__dirname, '..', 'uploads')),
  // 登录令牌有效期（毫秒），默认 7 天
  USER_TOKEN_TTL_MS: Number(process.env.USER_TOKEN_TTL_MS) || (7 * 24 * 3600 * 1000),
  // 注册域名限制（可选）：设置后仅允许该域名邮箱自助注册；首个注册者成为店长并创建组织。
  // 留空则为开放多租户模式（任意域名首个注册者各自创建独立组织）。
  REGISTER_DOMAIN: str(process.env.REGISTER_DOMAIN, '').toLowerCase(),
  // 超级管理员邮箱（可选，逗号分隔）：这些账号注册/首登时自动成为全局超级管理员。
  // 同时，系统首个注册用户也会自动成为超级管理员（便于初始开通）。
  SUPER_ADMIN_EMAILS: str(process.env.SUPER_ADMIN_EMAILS, '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // 防恶意注册：同一 IP 在窗口期内最多注册数（超阈值直接拒绝，挡自动化批量注册）
  REG_IP_LIMIT: Number(process.env.REG_IP_LIMIT) || 5,
  // 同一邮箱在窗口期内最多尝试注册数（防撞库/枚举，合法用户偶尔重试也受限，故默认 3）
  REG_EMAIL_LIMIT: Number(process.env.REG_EMAIL_LIMIT) || 3,
  // 注册频率限制窗口（毫秒），默认 24 小时
  REG_WINDOW_MS: Number(process.env.REG_WINDOW_MS) || (24 * 3600 * 1000),
  // 邀请制注册：开启后普通邮箱必须携带有效邀请码才能注册（超级管理员不受影响）
  // 部署时通过环境变量 INVITE_ONLY=1 开启
  INVITE_ONLY: str(process.env.INVITE_ONLY, '0') !== '0',
  // 源文件在线预览：默认开启。设为 0 可关闭（全部转为仅下载）。
  PREVIEW_ENABLED: (str(process.env.PREVIEW_ENABLED, '1') !== '0'),
  // 单个文件预览转换超时（毫秒），默认 60s。超时被杀并降级为仅下载。
  PREVIEW_TIMEOUT_MS: Number(process.env.PREVIEW_TIMEOUT_MS) || 60000,
  // 指定用于运行 server/preview_worker.py 的 Python 解释器（需装有 psd_tools + Pillow）。
  // 留空则自动探测（含本机 managed venv）。
  PYTHON_PATH: str(process.env.PYTHON_PATH, ''),
  // 对外基础地址（用于拼接微信 OAuth 回调地址），例如 https://share.example.com
  BASE_URL: str(process.env.BASE_URL, ''),

  WECHAT: {
    APPID: str(process.env.WECHAT_APPID, ''),
    SECRET: str(process.env.WECHAT_SECRET, ''),
    // 仅当 appid 与 secret 同时配置才启用真实 OAuth；否则走模拟流程（可演示）
    get enabled() { return !!(this.APPID && this.SECRET); }
  },

  COS: {
    SecretId: str(process.env.COS_SECRET_ID, ''),
    SecretKey: str(process.env.COS_SECRET_KEY, ''),
    Bucket: str(process.env.COS_BUCKET, ''),
    Region: str(process.env.COS_REGION, ''),
    // 可选：自定义访问域名（留空则内容始终经服务端 /api/content 下发，更安全）
    BaseUrl: str(process.env.COS_BASE_URL, ''),
    // 直连模式（/api/content、/api/preview 返回 302 跳转预签名 URL）下签名 URL 的有效期（秒）。
    // 短时效降低签名 URL 泄漏后的滥用窗口；每次 Range/下载请求都会重新校验会话并签发新 URL。
    SignExpires: Number(process.env.COS_SIGN_EXPIRES) || 300,
    get enabled() {
      return !!(this.SecretId && this.SecretKey && this.Bucket && this.Region);
    }
  },

  // Supabase（身份提供方 + 托管 Postgres）。配置后前端用 supabase-js 登录，
  // 后端直接拿令牌去问 Supabase 的 /auth/v1/user 端点做服务端校验（用公开的 anon key 即可），
  // 不再依赖 JWT_SECRET，避免前后端密钥不一致导致永远 invalid_token。不配置则回退自研账号体系。
  // JWT_SECRET 仍保留为可选字段（向后兼容），但已不再用于本地 HMAC 校验。
  SUPABASE: {
    URL: str(process.env.SUPABASE_URL, ''),
    ANON_KEY: str(process.env.SUPABASE_ANON_KEY, ''),
    JWT_SECRET: str(process.env.SUPABASE_JWT_SECRET, ''),
    // 只要 URL + ANON_KEY 齐全即启用 Supabase 身份体系（服务端校验无需 JWT_SECRET）
    get enabled() {
      return !!(this.URL && this.ANON_KEY);
    }
  },

  // 数据库：默认 sqlite（单机/MVP）；配置 postgres / mysql 以支撑更高并发（连接池）
  // 连接优先使用 DATABASE_URL，缺失时回退到 DB_HOST/PORT/USER/PASSWORD/NAME
  DB: {
    TYPE: str(process.env.DB_TYPE, 'sqlite'),
    URL: str(process.env.DATABASE_URL, ''),
    HOST: str(process.env.DB_HOST, '127.0.0.1'),
    PORT: Number(process.env.DB_PORT) || (str(process.env.DB_TYPE, 'sqlite') === 'mysql' ? 3306 : 5432),
    USER: str(process.env.DB_USER, ''),
    PASSWORD: str(process.env.DB_PASSWORD, ''),
    NAME: str(process.env.DB_NAME, 'safe_share'),
    // 是否启用 TLS（Supabase / RDS / AWS 等托管库默认强制）。可显式用 DB_SSL=1 开启。
    get SSL() {
      return str(process.env.DB_SSL, '') === '1' || /supabase|rds\.amazonaws|amazonaws/i.test(this.URL || '');
    },
    get config() {
      const base = this.URL
        ? { connectionString: this.URL }
        : {
            host: this.HOST, port: this.PORT, user: this.USER,
            password: this.PASSWORD, database: this.NAME
          };
      if (this.SSL) base.ssl = { rejectUnauthorized: false };
      return base;
    }
  }
};
