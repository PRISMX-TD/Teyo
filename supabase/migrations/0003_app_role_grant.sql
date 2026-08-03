-- 应用与测试连接以 postgres 身份登录，而 public 下的表归 postgres 所有。
-- Postgres 里「表的所有者默认绕过自己表上的 RLS」，所以直接用 postgres 跑查询时
-- 0002 里的策略形同不存在。正确做法是连上之后立刻 `set local role teyo_app`，
-- 让语句以无 BYPASSRLS 的受限角色执行——这需要 postgres 拥有 teyo_app 的成员资格。
-- Postgres 16 起，角色成员关系拆成 INHERIT 与 SET 两个独立选项。
-- Supabase 默认建出来的成员关系是 set=false，此时即便 grant 存在，
-- `set role teyo_app` 仍会报 "permission denied to set role"。
-- 必须显式 WITH SET TRUE 才能切换角色。
grant teyo_app to postgres with set true;

-- 注意：这里刻意不用 `alter table ... force row level security`。
-- app_is_member / app_has_role 是 SECURITY DEFINER，以所有者身份读 memberships，
-- 正是靠「所有者不受 RLS 约束」才能避开策略递归。一旦 force，memberships 上的
-- memberships_read 策略会在函数内部再次生效，而该策略又调用 app_is_member，
-- 形成策略递归，Postgres 会直接报错。隔离由「切到 teyo_app」保证，而不是 force。
