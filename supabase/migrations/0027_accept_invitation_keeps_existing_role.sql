-- 0005 的 app_accept_invitation 对已有成员记录做 `on conflict do update set role = excluded.role`，
-- 于是 owner 点开一封发给自己邮箱的邀请，就会被降级成邀请里的角色。公司因此没有 owner，
-- 没人能再管理成员或转让所有权。
--
-- 现在：已是活跃成员 → 拒绝（邀请不被消耗）；被暂停的成员 → 按邀请角色重新激活，
-- 与原行为一致。owner 无论什么状态都不会被邀请改写。
create or replace function app_accept_invitation(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation invitations;
  v_existing memberships;
  v_membership_id uuid;
begin
  -- for update 防止同一 token 并发兑换出两条成员记录。
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

  select * into v_existing
  from memberships
  where user_id = p_user_id and organization_id = v_invitation.organization_id
  for update;

  if found then
    if v_existing.status = 'active' or v_existing.role = 'owner' then
      raise exception 'invitation_already_member';
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
