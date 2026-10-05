-- 0030: 处理 Supabase 安全检查（database linter）报出的问题。
--
-- 应用只经由 DATABASE_URL 直连、并 `set local role teyo_app`，从不走
-- PostgREST（/rest/v1）。但 Supabase 会把 public schema 自动暴露给 anon 与
-- authenticated 角色，于是：
--
-- 1. schema_migrations 没有开 RLS，任何持有公开 anon key 的人都能经
--    /rest/v1/schema_migrations 读写迁移记录。开 RLS、不建策略 = 对 API 角色全拒；
--    迁移脚本以 postgres 身份运行，不受影响。
alter table schema_migrations enable row level security;

-- 2. 之前的 `revoke ... from public` 不够：Supabase 通过默认权限单独给
--    anon / authenticated 授予了函数执行权。这些 security definer 函数只该由
--    teyo_app 调用（RLS 策略内部或应用代码里），从 /rest/v1/rpc 一律关掉。
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('revoke execute on function %s from anon, authenticated, public', fn);
    execute format('grant execute on function %s to teyo_app', fn);
  end loop;
end
$$;

-- 以后新建的函数默认也不给 API 角色执行权。
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- 3. 固定 search_path，防止调用方通过改 search_path 劫持函数里引用的对象。
alter function assert_journal_balanced() set search_path = public;
alter function app_current_user_id() set search_path = public;
alter function app_protect_owner_membership() set search_path = public;
