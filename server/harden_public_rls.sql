-- ============================================================================
-- 安阅(safe-share) — 关闭 Supabase PostgREST 对 public 业务表的匿名访问
-- ----------------------------------------------------------------------------
-- 对应告警：rls_disabled_in_public（Table publicly accessible）
--           sensitive_columns_exposed（Sensitive data publicly accessible）
--
-- 原因：Supabase 默认把 public schema 暴露为 REST API（/rest/v1/<表名>），并给
--       anon / authenticated 角色授予 public 全部表的读写权限。本项目 11 张表
--       由服务端直连（DATABASE_URL）创建，没开 RLS → 任何人拿前端公开的
--       anon key 就能 读/改/删 全库（已实测：users 邮箱、sessions 查看令牌、
--       logs 访客 IP 定位全部可读）。
--
-- 为什么可以这么修：本项目所有业务表都只由服务端直连访问（前端只用 supabase-js
--   做登录，走 /auth/v1，不碰表）。直连角色就是建表者（owner），Postgres 的
--   owner 不受 RLS 约束（未使用 FORCE ROW LEVEL SECURITY），所以开启 RLS +
--   收回 anon/authenticated 权限后，应用读写完全不受影响，REST 入口则彻底关闭。
--
-- 用法：Supabase 控制台 → 左侧 SQL Editor → New query → 全选粘贴 → Run。
--       可重复执行（幂等），不会报错。
-- 回滚：见文件末尾注释。
-- ============================================================================

begin;

-- 1) public 下所有表开启 RLS。不给任何策略，等于对 anon / authenticated 一律拒绝。
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- 2) 收回 anon / authenticated 对 public 现有对象的全部权限（双保险）。
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
  end if;
end $$;

-- 3) 撤销「新建对象默认授权」——防止以后新增表又自动对 anon 开放（防回归）。
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
  end if;
end $$;

commit;

-- 执行完请自查（应全部返回 401 / 403，或空数组 []）：
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     'https://csggakvktvqxkugwwlef.supabase.co/rest/v1/users?select=*&limit=1' \
--     -H 'apikey: <你的 anon key>' -H 'Authorization: Bearer <你的 anon key>'

-- ---------------------------------------------------------------------------
-- 回滚（仅在应用报「数据读不到」时用，说明你的 DATABASE_URL 用的不是建表角色）：
--   do $$ declare t record; begin
--     for t in select tablename from pg_tables where schemaname='public' loop
--       execute format('alter table public.%I disable row level security', t.tablename);
--     end loop;
--   end $$;
--   grant all on all tables in schema public to anon, authenticated;
-- ---------------------------------------------------------------------------
