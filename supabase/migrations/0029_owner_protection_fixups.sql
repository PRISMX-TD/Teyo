-- 0029: 修正 0028 的两处问题。
--
-- 1. memberships_insert 里的 `exists (select 1 from organizations ...)` 会被
--    organizations_read（要求已是成员）过滤：建公司的人此刻还不是成员，看不到
--    自己刚插入的公司，策略恒为假，createOrganization 全部失败。
--    改用 security definer 函数一次判断「是我建的、且还没有任何成员」。
--
-- 2. owner 行的删除保护原本对所有身份生效，这会挡住 Supabase 控制台里的手工修复
--    与测试清理。改成与 update 一致，只约束应用角色 teyo_app。
--    删账号导致的级联删除仍有一道防线：organizations.created_by 引用 app_users
--    且没有 on delete，建公司的人在公司存在时删不掉。

create or replace function app_can_claim_ownership(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organizations o
    where o.id = org and o.created_by = app_current_user_id()
  )
  and not exists (select 1 from memberships m where m.organization_id = org);
$$;

revoke all on function app_can_claim_ownership(uuid) from public;
grant execute on function app_can_claim_ownership(uuid) to teyo_app;

drop policy if exists memberships_insert on memberships;
create policy memberships_insert on memberships
  for insert to teyo_app
  with check (
    user_id = app_current_user_id()
    and role = 'owner'
    and status = 'active'
    and app_can_claim_ownership(organization_id)
  );

drop function if exists app_org_has_members(uuid);

create or replace function app_protect_owner_membership()
returns trigger
language plpgsql
as $$
begin
  if current_user <> 'teyo_app' then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.role = 'owner' then
      raise exception 'owner_membership_protected'
        using hint = 'Transfer ownership or delete the company first.';
    end if;
    return old;
  end if;

  if (old.role = 'owner' or new.role = 'owner')
     and (old.role is distinct from new.role
          or new.status <> 'active'
          or new.user_id is distinct from old.user_id
          or new.organization_id is distinct from old.organization_id) then
    raise exception 'owner_membership_protected'
      using hint = 'Use app_transfer_ownership.';
  end if;

  return new;
end;
$$;
