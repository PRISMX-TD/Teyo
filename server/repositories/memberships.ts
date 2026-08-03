import type { Tx } from '@/server/db/transaction';
import type { MembershipStatus, Role } from '@/server/domain/permissions';

export type MemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: MembershipStatus;
  joinedAt: Date;
};

function mapMember(row: Record<string, unknown>): MemberRow {
  return {
    membershipId: row.id as string,
    userId: row.user_id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    role: row.role as Role,
    status: row.status as MembershipStatus,
    joinedAt: row.joined_at as Date,
  };
}

export async function listMembershipsByOrg(tx: Tx, organizationId: string): Promise<MemberRow[]> {
  const rows = await tx`
    select m.id, m.user_id, m.role, m.status, m.joined_at, u.email, u.display_name
    from memberships m
    join app_users u on u.id = m.user_id
    where m.organization_id = ${organizationId}
    order by
      case m.role when 'owner' then 0 when 'admin' then 1 when 'bookkeeper' then 2 else 3 end,
      u.display_name
  `;
  return rows.map(mapMember);
}

/**
 * 按 id 查成员，但同时用 organization_id 收窄。
 * 少了这个条件，调用方传入别家公司的 membershipId 就能改到别人的成员——
 * membershipId 是 uuid 但仍属用户输入，不能只靠它定位。
 */
export async function findMembership(
  tx: Tx,
  organizationId: string,
  membershipId: string,
): Promise<MemberRow | null> {
  const rows = await tx`
    select m.id, m.user_id, m.role, m.status, m.joined_at, u.email, u.display_name
    from memberships m
    join app_users u on u.id = m.user_id
    where m.organization_id = ${organizationId} and m.id = ${membershipId}
  `;
  const row = rows.at(0);
  return row ? mapMember(row) : null;
}

export async function findOwnerMembershipId(
  tx: Tx,
  organizationId: string,
): Promise<string | null> {
  const rows = await tx`
    select id from memberships
    where organization_id = ${organizationId} and role = 'owner'
  `;
  return (rows.at(0)?.id as string | undefined) ?? null;
}

export async function updateMembershipRole(
  tx: Tx,
  membershipId: string,
  role: Role,
): Promise<void> {
  await tx`update memberships set role = ${role} where id = ${membershipId}`;
}

export async function updateMembershipStatus(
  tx: Tx,
  membershipId: string,
  status: MembershipStatus,
): Promise<void> {
  await tx`update memberships set status = ${status} where id = ${membershipId}`;
}
