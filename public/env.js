'use strict';
// 部署配置（公开信息，可提交到仓库）。上线前把下面三项填成你的真实值。
window.API_BASE = '';            // 后端地址：留空=同源（本地 127.0.0.1:3000 与 Render 同域名部署都用这个）；若前端在 GitHub Pages、后端在 Render 异源，才填 Render 地址

// Supabase 公开配置（仅 URL 和 anon key，可提交到仓库）。
// 注意：SUPABASE_JWT_SECRET 是服务端密钥，永远不要写在这个公开文件里，
// 必须在后端 .env / 环境变量中配置，后端才会真正启用 Supabase 身份体系。
window.SUPABASE_URL = 'https://csggakvktvqxkugwwlef.supabase.co';        // 你的 Supabase 项目 URL
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNzZ2dha3ZrdHZxeGt1Z3d3bGVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMDY1MjksImV4cCI6MjEwNDc4MjUyOX0.xewPj_t9f_E16jCAkl3KBGWqMN7_UXu7surLqukOz20';   // 你的 Supabase anon/public key（公开，可提交）
window.FORCE_LEGACY_AUTH = false// 设为 true 强制走自研账号体系；走 Supabase 时，后端必须同时配置 SUPABASE_JWT_SECRET，否则登录成功也会被后端拒绝
window.ENABLE_WECHAT_LOGIN = false;// 设为 true 才显示「微信扫码登录」按钮（需先在 Supabase 或微信开放平台配好）

// 是否启用 Supabase 身份体系（由上面配置；未配置或被强制关闭则回退自研账号）
const USE_SUPABASE = !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY && !window.FORCE_LEGACY_AUTH);
// 创建全局 Supabase 客户端（若已加载 supabase-js），并自动把最新 access_token 同步进 localStorage，
// 解决 token 过期问题（Supabase 默认 1 小时过期，靠刷新令牌自动续期）。
if (USE_SUPABASE && window.supabase) {
  window.sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  // 仅当用户“已登录”（localStorage 中已有 userToken）时，才用 Supabase 刷新后的最新令牌覆盖，
  // 解决 token 过期自动续期问题。
  // 关键：绝不把浏览器残留的 Supabase 会话当成已登录态强行写入，否则会和后端 /api/auth/me
  // 校验冲突，触发 “写入令牌 → 401 → 清令牌并重载 → 又写入” 的页面刷新死循环。
  const refreshToken = (session) => {
    if (session && localStorage.getItem('userToken')) {
      localStorage.setItem('userToken', session.access_token);
    }
  };
  window.sb.auth.onAuthStateChange((_event, session) => refreshToken(session));
  window.sb.auth.getSession().then(({ data }) => refreshToken(data.session));
}

// 全局 fetch 包装：把相对 /api/ 请求自动指向 API_BASE（GitHub Pages 异源调用必需）。
// 其他页面无需改动，所有 fetch('/api/...') 都会被这里接管。
(function () {
  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!nativeFetch) return;
  window.fetch = function (input, init) {
    if (typeof input === 'string' && input.indexOf('/api/') === 0 && window.API_BASE) {
      var base = window.API_BASE.replace(/\/+$/, '');
      input = base + input;
    }
    return nativeFetch(input, init);
  };
})();
