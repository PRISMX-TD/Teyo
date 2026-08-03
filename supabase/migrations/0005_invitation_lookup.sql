-- 接受邀请时用户还不是成员，invitations_manage 策略（要求 owner/admin）查不到邀请，
-- 因此用 security definer 函数按 token 哈希精确查找单条记录。
-- 只能按哈希精确匹配，无法枚举：调用方必须先持有明文 token。
create or replace function app_find_invitation(p_token_hash text)
returns table (
  id uuid,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  email text,
  role membership_role,
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id,
    i.organization_id,
    o.name,
    o.slug,
    i.email,
    i.role,
    i.expires_at,
    i.accepted_at,
    i.revoked_at
  from invitations i
  join organizations o on o.id = i.organization_id
  where i.token_hash = p_token_hash;
$$;

revoke all on function app_find_invitation(text) from public;
grant execute on function app_find_invitation(text) to teyo_app;

-- 接受邀请要同时写 memberships 和 invitations.accepted_at，两者都绕不过成员策略。
-- 放在一个 security definer 函数里，既保证原子性，也把校验集中在数据库侧：
-- 即便应用层漏检，过期/已撤销/已接受的邀请也无法兑换成成员资格。
create or replace function app_accept_invitation(p_token_hash text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invitation invitations;
  v_membership_id uuid;
begin
  -- for update 防止同一 token 并发兑换出两条成员记录。
  select * into v_invitation
  from invitations
  where token_hash = p_token_hash
  for update;

  -- 用 not found 而不是 `v_invitation is null`：两者在这里等价
  -- （未命中时行变量全字段为 NULL，record IS NULL 对全 NULL 行为 true），
  -- 但 not found 不依赖这个细节，意图更直白。
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

  insert into memberships (user_id, organization_id, role, status)
  values (p_user_id, v_invitation.organization_id, v_invitation.role, 'active')
  on conflict (user_id, organization_id) do update
    set status = 'active', role = excluded.role
  returning id into v_membership_id;

  update invitations set accepted_at = now() where id = v_invitation.id;

  return v_membership_id;
end;
$$;

revoke all on function app_accept_invitation(text, uuid) from public;
grant execute on function app_accept_invitation(text, uuid) to teyo_app;
