import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Tx } from '@/server/db/transaction';
import type { Role } from '@/server/domain/permissions';

export const INVITATION_TTL_DAYS = 7;

export type InvitationRow = {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  email: string;
  role: Role;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

/**
 * token 只在返回值里出现一次（用于拼邮件链接），数据库只存 SHA-256 哈希。
 * 32 字节随机量足以抵御暴力枚举；哈希不加盐是有意的——查找必须按哈希精确匹配，
 * 而 token 本身就是高熵随机值，不存在字典攻击的前提。
 */
export function generateInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mapInvitation(row: Record<string, unknown>): InvitationRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    organizationName: row.organization_name as string,
    organizationSlug: row.organization_slug as string,
    email: row.email as string,
    role: row.role as Role,
    expiresAt: row.expires_at as Date,
    acceptedAt: (row.accepted_at as Date | null) ?? null,
    revokedAt: (row.revoked_at as Date | null) ?? null,
  };
}

/**
 * id 在应用侧生成，不用 `returning id`：RETURNING 的行要额外过 SELECT 策略，
 * 而 invitations 只有一条 invitations_manage 策略，其 using 子句在 insert 语句里
 * 不保证可用。自己生成 uuid 更稳，也和 organizations 的做法保持一致。
 *
 * TTL 用 make_interval 而不是把天数拼进 interval 字面量：
 * 字面量里的占位符不会被参数化，只能走字符串拼接，那是注入面。
 */
export async function insertInvitation(
  tx: Tx,
  input: {
    organizationId: string;
    email: string;
    role: Role;
    tokenHash: string;
    invitedBy: string;
  },
): Promise<string> {
  const id = randomUUID();
  await tx`
    insert into invitations
      (id, organization_id, email, role, token_hash, expires_at, invited_by)
    values (
      ${id},
      ${input.organizationId},
      ${input.email},
      ${input.role},
      ${input.tokenHash},
      now() + make_interval(days => ${INVITATION_TTL_DAYS}),
      ${input.invitedBy}
    )
  `;
  return id;
}

export async function listPendingInvitations(
  tx: Tx,
  organizationId: string,
): Promise<InvitationRow[]> {
  const rows = await tx`
    select i.id, i.organization_id, o.name as organization_name, o.slug as organization_slug,
           i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at
    from invitations i
    join organizations o on o.id = i.organization_id
    where i.organization_id = ${organizationId}
      and i.accepted_at is null
      and i.revoked_at is null
    order by i.created_at desc
  `;
  return rows.map(mapInvitation);
}

/** 只撤销仍处于待处理状态的邀请；已接受或已撤销的返回 false 交由调用方报错。 */
export async function markInvitationRevoked(
  tx: Tx,
  organizationId: string,
  invitationId: string,
): Promise<boolean> {
  const rows = await tx`
    update invitations
    set revoked_at = now()
    where id = ${invitationId}
      and organization_id = ${organizationId}
      and accepted_at is null
      and revoked_at is null
    returning id
  `;
  return rows.length > 0;
}

/** 走 security definer 函数，因为接受者此时还不是成员，普通策略查不到。 */
export async function findInvitationByToken(tx: Tx, token: string): Promise<InvitationRow | null> {
  const rows = await tx`select * from app_find_invitation(${hashToken(token)})`;
  const row = rows.at(0);
  return row ? mapInvitation(row) : null;
}

export async function acceptInvitationByToken(
  tx: Tx,
  token: string,
  userId: string,
): Promise<string> {
  const rows = await tx`
    select app_accept_invitation(${hashToken(token)}, ${userId}) as membership_id
  `;
  return rows[0].membership_id as string;
}
