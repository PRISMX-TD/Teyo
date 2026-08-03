-- 应用角色：故意不给 BYPASSRLS
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'teyo_app') then
    create role teyo_app nologin;
  end if;
end
$$;

grant usage on schema public to teyo_app;
grant select, insert, update, delete on all tables in schema public to teyo_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to teyo_app;

-- audit_logs 只允许读写，不允许改删
revoke update, delete on audit_logs from teyo_app;

-- 当前用户上下文
create or replace function app_current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

create or replace function app_is_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from memberships m
    where m.organization_id = org
      and m.user_id = app_current_user_id()
      and m.status = 'active'
  );
$$;

create or replace function app_has_role(org uuid, roles membership_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from memberships m
    where m.organization_id = org
      and m.user_id = app_current_user_id()
      and m.status = 'active'
      and m.role = any (roles)
  );
$$;

-- 启用 RLS
alter table app_users enable row level security;
alter table organizations enable row level security;
alter table memberships enable row level security;
alter table invitations enable row level security;
alter table accounts enable row level security;
alter table categories enable row level security;
alter table transactions enable row level security;
alter table journal_lines enable row level security;
alter table attachments enable row level security;
alter table exchange_rates enable row level security;
alter table audit_logs enable row level security;

-- app_users：本人可读写自己；同公司成员可读（用于显示创建人姓名）
create policy app_users_self on app_users
  for all to teyo_app
  using (id = app_current_user_id())
  with check (id = app_current_user_id());

create policy app_users_visible_to_colleagues on app_users
  for select to teyo_app
  using (
    exists (
      select 1
      from memberships mine
      join memberships theirs on theirs.organization_id = mine.organization_id
      where mine.user_id = app_current_user_id()
        and mine.status = 'active'
        and theirs.user_id = app_users.id
    )
  );

-- organizations：成员可读；owner 可改；任何登录用户可建
create policy organizations_read on organizations
  for select to teyo_app
  using (app_is_member(id));

create policy organizations_insert on organizations
  for insert to teyo_app
  with check (created_by = app_current_user_id());

create policy organizations_update on organizations
  for update to teyo_app
  using (app_has_role(id, array['owner', 'admin']::membership_role[]))
  with check (app_has_role(id, array['owner', 'admin']::membership_role[]));

create policy organizations_delete on organizations
  for delete to teyo_app
  using (app_has_role(id, array['owner']::membership_role[]));

-- memberships：自己的记录可读；同公司成员可读；owner/admin 可管
create policy memberships_read on memberships
  for select to teyo_app
  using (user_id = app_current_user_id() or app_is_member(organization_id));

create policy memberships_insert on memberships
  for insert to teyo_app
  with check (
    -- 创建公司时自建 owner 记录，或 owner/admin 添加成员，或本人接受邀请
    user_id = app_current_user_id()
    or app_has_role(organization_id, array['owner', 'admin']::membership_role[])
  );

create policy memberships_update on memberships
  for update to teyo_app
  using (app_has_role(organization_id, array['owner', 'admin']::membership_role[]))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

create policy memberships_delete on memberships
  for delete to teyo_app
  using (app_has_role(organization_id, array['owner']::membership_role[]));

-- invitations：owner/admin 全权；被邀请者按 token 查询走 security definer 函数，不依赖此策略
create policy invitations_manage on invitations
  for all to teyo_app
  using (app_has_role(organization_id, array['owner', 'admin']::membership_role[]))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

-- accounts / categories：成员可读，owner/admin 可写
create policy accounts_read on accounts
  for select to teyo_app
  using (app_is_member(organization_id));

create policy accounts_write on accounts
  for all to teyo_app
  using (app_has_role(organization_id, array['owner', 'admin']::membership_role[]))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

create policy categories_read on categories
  for select to teyo_app
  using (app_is_member(organization_id));

create policy categories_write on categories
  for all to teyo_app
  using (app_has_role(organization_id, array['owner', 'admin']::membership_role[]))
  with check (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

-- transactions：成员可读；owner/admin/bookkeeper 可建；
-- 修改权限按角色区分，bookkeeper 只能改自己创建的
create policy transactions_read on transactions
  for select to teyo_app
  using (app_is_member(organization_id));

create policy transactions_insert on transactions
  for insert to teyo_app
  with check (
    app_has_role(
      organization_id,
      array['owner', 'admin', 'bookkeeper']::membership_role[]
    )
    and created_by = app_current_user_id()
  );

create policy transactions_update on transactions
  for update to teyo_app
  using (
    app_has_role(organization_id, array['owner', 'admin']::membership_role[])
    or (
      app_has_role(organization_id, array['bookkeeper']::membership_role[])
      and created_by = app_current_user_id()
    )
  )
  with check (
    app_has_role(organization_id, array['owner', 'admin']::membership_role[])
    or (
      app_has_role(organization_id, array['bookkeeper']::membership_role[])
      and created_by = app_current_user_id()
    )
  );

-- 不提供 delete 策略：软删除通过 update 完成，硬删除在数据库层就不可能

-- journal_lines / attachments：跟随所属交易的公司
create policy journal_lines_read on journal_lines
  for select to teyo_app
  using (app_is_member(organization_id));

create policy journal_lines_write on journal_lines
  for all to teyo_app
  using (
    app_has_role(
      organization_id,
      array['owner', 'admin', 'bookkeeper']::membership_role[]
    )
  )
  with check (
    app_has_role(
      organization_id,
      array['owner', 'admin', 'bookkeeper']::membership_role[]
    )
  );

create policy attachments_read on attachments
  for select to teyo_app
  using (app_is_member(organization_id));

create policy attachments_write on attachments
  for all to teyo_app
  using (
    app_has_role(
      organization_id,
      array['owner', 'admin', 'bookkeeper']::membership_role[]
    )
  )
  with check (
    app_has_role(
      organization_id,
      array['owner', 'admin', 'bookkeeper']::membership_role[]
    )
  );

-- exchange_rates：全局共享数据，任何登录用户可读；写入只经由 cron（service role）
create policy exchange_rates_read on exchange_rates
  for select to teyo_app
  using (app_current_user_id() is not null);

-- audit_logs：owner/admin 可读；成员可写入自己的动作；无 update/delete 策略
create policy audit_logs_read on audit_logs
  for select to teyo_app
  using (app_has_role(organization_id, array['owner', 'admin']::membership_role[]));

create policy audit_logs_insert on audit_logs
  for insert to teyo_app
  with check (
    app_is_member(organization_id)
    and actor_user_id = app_current_user_id()
  );
