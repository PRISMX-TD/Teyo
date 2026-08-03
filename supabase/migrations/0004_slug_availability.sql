-- slug 全局唯一，但 organizations_read 策略是 app_is_member(id)，
-- 也就是说在 teyo_app 角色下查 `where slug = ?` 只能看到自己所属的公司。
-- 于是「别人已占用的 slug」会被判为可用，插入时才撞上 organizations_slug_key，
-- 用户看到的是一个裸的数据库约束错误。
--
-- 这里用 SECURITY DEFINER 以所有者身份检查占用情况，绕过 RLS。
-- 只返回布尔值，不泄露那家公司的任何信息（名称、归属都拿不到），
-- 因此不构成越权读取。手法与 app_is_member 一致。
create or replace function app_slug_taken(candidate text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from organizations o where o.slug = candidate);
$$;

revoke all on function app_slug_taken(text) from public;
grant execute on function app_slug_taken(text) to teyo_app;
