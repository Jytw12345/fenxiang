'use strict';
// 全局参数中心：超管后台可实时修改、DB 落库、即时生效，无需改 .env 重启。
//
// 扩展方式：只需在下面 REGISTRY 里加一项（key / type / group / label / default / env / help），
// 再在 server/index.js 用 globals.get('key') 读取即可接入运行时行为。value 存储为 JSON 字符串。
const db = require('./db');

// type: bool | int | string | enum
const REGISTRY = [
  // —— 注册与账号 ——
  { key: 'invite_only', env: 'INVITE_ONLY', type: 'bool', group: '注册与账号', label: '邀请制注册',
    default: false, help: '开启后普通邮箱必须携带有效邀请码才能注册，超级管理员不受影响。' },
  { key: 'register_domain', env: 'REGISTER_DOMAIN', type: 'string', group: '注册与账号', label: '允许注册的邮箱域名',
    default: '', help: '留空表示不限制；填入如 example.com 则仅允许该域名邮箱自助注册（域名校验大小写不敏感）。' },
  { key: 'reg_ip_limit', env: 'REG_IP_LIMIT', type: 'int', group: '注册与账号', label: '同 IP 注册上限（窗口内）',
    default: 5, help: '同一 IP 在注册频率窗口内最多注册数，超过直接拒绝，防自动化批量注册。' },
  { key: 'reg_email_limit', env: 'REG_EMAIL_LIMIT', type: 'int', group: '注册与账号', label: '同邮箱重试上限（窗口内）',
    default: 3, help: '同一邮箱在窗口内最多注册尝试次数，防撞库/枚举。' },
  { key: 'reg_window_ms', env: 'REG_WINDOW_MS', type: 'int', group: '注册与账号', label: '注册频率窗口（毫秒）',
    default: 24 * 3600 * 1000, help: '注册限频统计窗口，默认 24 小时。' },
  { key: 'user_token_ttl_ms', env: 'USER_TOKEN_TTL_MS', type: 'int', group: '注册与账号', label: '登录令牌有效期（毫秒）',
    default: 7 * 24 * 3600 * 1000, help: '用户登录令牌的过期时长，默认 7 天。' },

  // —— 预览与处理 ——
  { key: 'preview_enabled', env: 'PREVIEW_ENABLED', type: 'bool', group: '预览与处理', label: '启用在线预览',
    default: true, help: '关闭后所有文件仅支持下载，不进行源文件预览转换。' },
  { key: 'preview_timeout_ms', env: 'PREVIEW_TIMEOUT_MS', type: 'int', group: '预览与处理', label: '预览转换超时（毫秒）',
    default: 60000, help: '单个文件预览转换超时，超时降级为仅下载。' },

  // —— 防盗用默认策略（新建分享时的全局默认，创建时可覆盖） ——
  { key: 'default_watermark_mode', env: '', type: 'enum', options: ['none', 'static', 'dynamic'], group: '防盗用默认策略',
    label: '默认水印模式', default: 'none', help: '新建分享默认采用的水印模式（none / static / dynamic）。' },
  { key: 'default_download_watermark', env: '', type: 'bool', group: '防盗用默认策略', label: '默认开启下载带水印',
    default: false, help: '新建分享默认是否生成“下载带水印副本”。' },
  { key: 'default_antiforward', env: '', type: 'bool', group: '防盗用默认策略', label: '默认开启链接防转发',
    default: false, help: '新建分享默认是否绑定首次打开的设备（链接防转发）。' }
];

let cache = null; // { key: { value, source } }，source: 'db' | 'env' | 'default'

function envValueOf(entry) {
  if (!entry.env) return undefined;
  const raw = process.env[entry.env];
  if (raw === undefined || raw === '') return undefined;
  if (entry.type === 'bool') return raw !== '0' && raw !== 'false' && raw !== 'no';
  if (entry.type === 'int') return Number(raw);
  return raw;
}

function coerce(entry, v) {
  if (entry.type === 'bool') return !!v;
  if (entry.type === 'int') { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : entry.default; }
  if (entry.type === 'enum' && entry.options) return entry.options.includes(v) ? v : entry.default;
  return v == null ? '' : String(v);
}

// 启动时（或 DB 变更后）调用：加载 DB 覆盖 -> 回退环境变量 -> 回退默认值，并缓存。
async function loadEffective() {
  let rows = {};
  try { rows = await db.getGlobalSettings() || {}; } catch (e) { rows = {}; }
  const out = {};
  for (const e of REGISTRY) {
    if (Object.prototype.hasOwnProperty.call(rows, e.key)) {
      let parsed = rows[e.key];
      try { parsed = JSON.parse(rows[e.key]); } catch (_) { /* 存的是原始字符串也兼容 */ }
      out[e.key] = { value: coerce(e, parsed), source: 'db' };
    } else {
      const ev = envValueOf(e);
      if (ev !== undefined) out[e.key] = { value: coerce(e, ev), source: 'env' };
      else out[e.key] = { value: e.default, source: 'default' };
    }
  }
  cache = out;
  return out;
}

// 读取生效值（缓存命中优先，避免每次读 DB）。
function get(key) {
  if (cache && cache[key]) return cache[key].value;
  const e = REGISTRY.find(x => x.key === key);
  if (!e) return undefined;
  const ev = envValueOf(e);
  return ev !== undefined ? coerce(e, ev) : e.default;
}

// 供前端（超管面板）拉取：注册表 + 当前生效值 + 来源，按分组排序。
async function listForApi() {
  if (!cache) await loadEffective();
  const groups = [];
  const map = {};
  for (const e of REGISTRY) {
    if (!map[e.group]) { map[e.group] = []; groups.push(e.group); }
    map[e.group].push({
      key: e.key, label: e.label, type: e.type,
      options: e.options || null, help: e.help || '',
      default: e.default, value: cache[e.key].value, source: cache[e.key].source
    });
  }
  return { groups: groups.map(g => ({ group: g, items: map[g] })) };
}

// 超管保存单个参数。校验类型后写入 DB 并刷新缓存。
async function setOne(key, rawValue) {
  const e = REGISTRY.find(x => x.key === key);
  if (!e) { const err = new Error('未知全局参数：' + key); err.status = 400; err.code = 'unknown_key'; throw err; }
  const value = coerce(e, rawValue);
  await db.setGlobalSetting(key, JSON.stringify(value), Date.now());
  if (!cache) await loadEffective();
  cache[key] = { value, source: 'db' };
  return { key, value, source: 'db' };
}

// 暴露给创建分享流程的安全子集（前端创建表单拉取默认水印/防转发）。
function publicDefaults() {
  return {
    default_watermark_mode: get('default_watermark_mode'),
    default_download_watermark: get('default_download_watermark'),
    default_antiforward: get('default_antiforward')
  };
}

module.exports = { REGISTRY, loadEffective, get, listForApi, setOne, publicDefaults };
