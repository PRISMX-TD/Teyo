-- 0028: 在数据库层保证「每家公司始终有一个活跃 owner」，并收紧成员表的写入口。
--
-- 此前这条不变量只靠 server/actions/members.ts 的应用层检查维持；0027 修的
-- 「owner 接受自己的邀请被降级」就是绕过应用层的一条路。这里把剩下的几条也堵上：
--   1. teyo_app 直接 update owner 行（admin 改 owner 的角色/状态）
--   2. 删除 owner 行（memberships_delete、或删账号时级联）
--   3. memberships_insert 允许任何登录用户把自己以任意角色插进任意公司
--   4. app_users_self 是 FOR ALL，teyo_app 能删自己的 app_users 行，级联掉 owner
--   5. 邀请不校验邮箱：拿到链接的任何人都能以邀请角色加入

-- ---------------------------------------------------------------------------
-- 1 + 2. owner 行保护触发器
--
-- 判据用 current_user：应用的所有请求都 `set local role teyo_app`，而
-- security definer 函数（app_transfer_ownership）里 current_user 是函数所有者。
-- 所以「改 owner 只能经由转让函数」可以精确表达，同时 Supabase 控制台
-- （postgres 身份）仍能手动修数据——上一次公司没有 owner 就是这样救回来的。
-- 删除对所有身份都拒绝，唯一例外是公司本身已被删除（级联删除时父行已不可见）。
create or replace function app_protect_owner_membership()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.role = 'owner'
       and exists (select 1 from organizations where id = old.organization_id) then
      raise exception 'owner_membership_protected'
        using hint = 'Transfer ownership or delete the company first.';
    end if;
    return old;
  end if;

  if current_user = 'teyo_app' then
    if tg_op = 'UPDATE'
       and (old.role = 'owner' or new.role = 'owner')
       and (old.role is distinct from new.role
            or new.status <> 'active'
            or new.user_id is distinct from old.user_id
            or new.organization_id is distinct from old.organization_id) then
      raise exception 'owner_membership_protected'
        using hint = 'Use app_transfer_ownership.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists memberships_protect_owner on memberships;
create trigger memberships_protect_owner
  before update or delete on memberships
  for each row execute function app_protect_owner_membership();

-- 原子的所有权转让：降级旧 owner 与提升新 owner 在同一个函数里完成，
-- 调用者必须是这家公司的活跃 owner。
create or replace function app_transfer_ownership(p_org uuid, p_target_membership uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner memberships;
  v_target memberships;
begin
  select * into v_owner
  from memberships
  where organization_id = p_org and role = 'owner'
  for update;

  if not found or v_owner.user_id is distinct from app_current_user_id()
     or v_owner.status <> 'active' then
    raise exception 'ownership_transfer_forbidden';
  end if;

  select * into v_target
  from memberships
  where id = p_target_membership and organization_id = p_org
  for update;

  if not found then
    raise exception 'ownership_transfer_target_not_found';
  end if;
  if v_target.status <> 'active' then
    raise exception 'ownership_transfer_target_inactive';
  end if;
  if v_target.role = 'owner' then
    raise exception 'ownership_transfer_target_is_owner';
  end if;

  -- memberships_single_owner 要求先腾出 owner 位置。
  update memberships set role = 'admin' where id = v_owner.id;
  update memberships set role = 'owner' where id = v_target.id;
end;
$$;

revoke all on function app_transfer_ownership(uuid, uuid) from public;
grant execute on function app_transfer_ownership(uuid, uuid) to teyo_app;

-- ---------------------------------------------------------------------------
-- 3. memberships_insert：唯一合法的 teyo_app 直接插入是「建公司时插入自己的 owner 行」。
-- 接受邀请走 security definer 的 app_accept_invitation，不经过这条策略。
--
-- 「这家公司还没有任何成员」必须用 security definer 函数判断：策略里直接
-- 查 memberships 会被 memberships_read 过滤，非成员什么都看不到，not exists 恒真。
create or replace function app_org_has_members(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from memberships where organization_id = org);
$$;

revoke all on function app_org_has_members(uuid) from public;
grant execute on function app_org_has_members(uuid) to teyo_app;

drop policy if exists memberships_insert on memberships;
create policy memberships_insert on memberships
  for insert to teyo_app
  with check (
    user_id = app_current_user_id()
    and role = 'owner'
    and status = 'active'
    and exists (
      select 1 from organizations o
      where o.id = organization_id and o.created_by = app_current_user_id()
    )
    and not app_org_has_members(organization_id)
  );

-- ---------------------------------------------------------------------------
-- 4. 应用从不删除 app_users；删账号若要做，必须先转让或删除公司。
revoke delete on app_users from teyo_app;

-- ---------------------------------------------------------------------------
-- 5. 接受邀请：在 0027 的基础上
--    - 要求接受者的邮箱与邀请邮箱一致（链接被转发不能让别人以该角色加入）
--    - 被暂停的成员只有在邀请人当前是 owner 时才能经由邀请重新激活
--      （否则 admin 可以用一封邀请撤销 owner 做出的暂停决定）
create or replace function app_accept_invitation(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation invitations;
  v_existing memberships;
  v_user_email text;
  v_membership_id uuid;
begin
  select * into v_invitation
  from invitations
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'invitation_not_found';
  end if;
  if v_invitation.revoked_at is not null then
    raise exception 'invitation_revoked';
  end if;
  if v_invitation.accepted_at is not null then
    raise exception 'invitation_already_accepted';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception 'invitation_expired';
  end if;

  select email into v_user_email from app_users where id = p_user_id;
  if v_user_email is null or lower(v_user_email) <> lower(v_invitation.email) then
    raise exception 'invitation_email_mismatch';
  end if;

  select * into v_existing
  from memberships
  where user_id = p_user_id and organization_id = v_invitation.organization_id
  for update;

  if found then
    if v_existing.status = 'active' or v_existing.role = 'owner' then
      raise exception 'invitation_already_member';
    end if;

    if not exists (
      select 1 from memberships
      where organization_id = v_invitation.organization_id
        and user_id = v_invitation.invited_by
        and role = 'owner'
        and status = 'active'
    ) then
      raise exception 'invitation_member_suspended';
    end if;

    update memberships
    set status = 'active', role = v_invitation.role
    where id = v_existing.id
    returning id into v_membership_id;
  else
    insert into memberships (user_id, organization_id, role, status)
    values (p_user_id, v_invitation.organization_id, v_invitation.role, 'active')
    returning id into v_membership_id;
  end if;

  update invitations set accepted_at = now() where id = v_invitation.id;

  return v_membership_id;
end;
$$;

revoke all on function app_accept_invitation(text, uuid) from public;
grant execute on function app_accept_invitation(text, uuid) to teyo_app;
