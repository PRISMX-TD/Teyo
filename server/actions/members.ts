'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { inviteMemberSchema, memberRoleSchema } from '@/lib/schemas';
import { AuthError, requirePermission, requireUserId } from '@/server/auth/guard';
import { withTransaction, withoutUserContext } from '@/server/db/transaction';
import type { MembershipStatus, Role } from '@/server/domain/permissions';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  acceptInvitationByToken,
  findInvitationByToken,
  generateInvitationToken,
  insertInvitation,
  isActiveMemberEmail,
  listPendingInvitations,
  markInvitationRevoked,
  type InvitationRow,
} from '@/server/repositories/invitations';
import {
  findMembership,
  listMembershipsByOrg,
  updateMembershipRole,
  updateMembershipStatus,
  type MemberRow,
} from '@/server/repositories/memberships';

/**
 * 成员管理的层级：owner 管所有人；admin 只能管理 bookkeeper / viewer，
 * 不能授予、撤销或修改 admin 角色——否则一个 admin 就能把其他 admin 全部
 * 暂停或降级，或把任何人提成 admin。任何人都不能修改自己的成员记录。
 */
function assertCanManage(
  context: { userId: string; role: Role },
  target: { userId: string; role: Role },
  nextRole?: Role,
): void {
  if (target.userId === context.userId) {
    throw new AuthError('forbidden', 'You cannot change your own membership.');
  }
  if (context.role === 'owner') return;
  if (target.role === 'admin' || nextRole === 'admin') {
    throw new AuthError('forbidden', 'Only the owner can manage admins.');
  }
}

/** app_accept_invitation / app_transfer_ownership / 触发器抛出的错误码 → 可读提示。 */
const DB_ERROR_MESSAGES: Record<string, string> = {
  invitation_already_member: 'You are already a member of this company.',
  invitation_email_mismatch:
    'This invitation was sent to a different email address. Sign in with that email to accept it.',
  invitation_member_suspended:
    'Your membership in this company is suspended. Ask the owner to reinstate you.',
  invitation_revoked: 'This invitation was revoked.',
  invitation_already_accepted: 'This invitation was already accepted.',
  invitation_expired: 'This invitation has expired.',
  invitation_not_found: 'This invitation link is not valid.',
  owner_membership_protected: 'The owner cannot be changed this way. Use ownership transfer.',
  ownership_transfer_forbidden: 'Only the owner can transfer ownership.',
  ownership_transfer_target_not_found: 'That member does not exist.',
  ownership_transfer_target_inactive: 'Only an active member can become the owner.',
  ownership_transfer_target_is_owner: 'That member is already the owner.',
};

/**
 * setMemberStatus / revokeInvitation / transferOwnership 的入参。它们是可直接
 * POST 的端点，TypeScript 的联合类型到运行时就不存在了：status 原来照单全收
 * （能写进 'invited'），非 uuid 的 id 则一路落到 Postgres 报 22P02。
 */
const memberStatusSchema = z.object({
  membershipId: z.string().uuid(),
  status: z.enum(['active', 'suspended']),
});
const idSchema = z.string().uuid();

function translateDbError(error: unknown): never {
  if (error instanceof Error) {
    for (const [code, message] of Object.entries(DB_ERROR_MESSAGES)) {
      if (error.message.includes(code)) {
        throw new AuthError(code.endsWith('not_found') ? 'not_found' : 'forbidden', message);
      }
    }
  }
  throw error;
}

export async function listMembers(orgSlug: string): Promise<MemberRow[]> {
  const context = await requirePermission(orgSlug, 'member:manage');
  return withTransaction(context.userId, (tx) => listMembershipsByOrg(tx, context.organizationId));
}

export async function listInvitations(orgSlug: string): Promise<InvitationRow[]> {
  const context = await requirePermission(orgSlug, 'member:manage');
  return withTransaction(context.userId, (tx) =>
    listPendingInvitations(tx, context.organizationId),
  );
}

export async function inviteMember(
  orgSlug: string,
  input: { email: string; role: Role },
): Promise<{ token: string }> {
  const data = inviteMemberSchema.parse(input);
  const context = await requirePermission(orgSlug, 'member:manage');
  if (data.role === 'admin' && context.role !== 'owner') {
    throw new AuthError('forbidden', 'Only the owner can invite admins.');
  }
  const { token, tokenHash } = generateInvitationToken();

  await withTransaction(context.userId, async (tx) => {
    if (await isActiveMemberEmail(tx, context.organizationId, data.email)) {
      throw new AuthError('forbidden', 'That person is already a member of this company.');
    }

    const invitationId = await insertInvitation(tx, {
      organizationId: context.organizationId,
      email: data.email,
      role: data.role,
      tokenHash,
      invitedBy: context.userId,
    });

    // 审计里只留邮箱与角色。token 和它的哈希都不写入，
    // 否则有 audit:read 权限的 admin 就能拿到别人的邀请链接。
    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: invitationId,
      after: { email: data.email, role: data.role },
    });
  });

  // 邮件发送在 Task 21 接入，这里返回 token 供调用方组装链接。
  revalidatePath(`/${orgSlug}/settings/members`);
  return { token };
}

export async function revokeInvitation(orgSlug: string, invitationId: string): Promise<void> {
  idSchema.parse(invitationId);
  const context = await requirePermission(orgSlug, 'member:manage');

  await withTransaction(context.userId, async (tx) => {
    const revoked = await markInvitationRevoked(tx, context.organizationId, invitationId);
    if (!revoked) {
      throw new AuthError('not_found', 'That invitation is no longer pending.');
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'invitation.revoked',
      entityType: 'invitation',
      entityId: invitationId,
    });
  });

  revalidatePath(`/${orgSlug}/settings/members`);
}

export async function acceptInvitation(token: string): Promise<{ orgSlug: string }> {
  const userId = await requireUserId();

  return withTransaction(userId, async (tx) => {
    const invitation = await findInvitationByToken(tx, token);
    if (!invitation) {
      throw new AuthError('not_found', 'This invitation link is not valid.');
    }
    if (invitation.revokedAt) {
      throw new AuthError('forbidden', 'This invitation was revoked.');
    }
    if (invitation.acceptedAt) {
      throw new AuthError('forbidden', 'This invitation was already accepted.');
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new AuthError('forbidden', 'This invitation has expired.');
    }

    // 上面的检查是为了给出可读的错误信息；
    // app_accept_invitation 内部会在行锁下重新校验一遍，是真正的权威判断。
    const membershipId = await acceptInvitationByToken(tx, token, userId).catch(translateDbError);

    await recordAudit(tx, {
      organizationId: invitation.organizationId,
      actorUserId: userId,
      action: 'membership.accepted',
      entityType: 'membership',
      entityId: membershipId,
      after: { role: invitation.role },
    });

    return { orgSlug: invitation.organizationSlug };
  });
}

export type MyInvitation = { id: string; organizationName: string; role: Role };

/**
 * 发给当前登录邮箱、仍待处理的邀请。onboarding 用它让「弄丢了邀请链接」的人
 * 也能加入公司，而不是只能新建一家。
 *
 * 走 withoutUserContext 的理由与 getInvitationPreview 相同：此刻还不是成员，
 * 任何按成员关系过滤的策略都查不到。收窄靠 where 里的邮箱等值匹配。
 */
export async function listMyPendingInvitations(): Promise<MyInvitation[]> {
  const userId = await requireUserId();
  const rows = await withoutUserContext(
    (tx) => tx`
      select i.id, o.name as organization_name, i.role
      from invitations i
      join organizations o on o.id = i.organization_id
      join app_users u on lower(u.email) = lower(i.email)
      where u.id = ${userId}
        and i.accepted_at is null
        and i.revoked_at is null
        and i.expires_at > now()
        and not exists (
          select 1 from memberships m
          where m.organization_id = i.organization_id and m.user_id = u.id
        )
      order by i.created_at desc
    `,
  );
  return rows.map((r) => ({
    id: r.id as string,
    organizationName: r.organization_name as string,
    role: r.role as Role,
  }));
}

/** 当前账号被暂停的公司名称，给 onboarding / 首页解释「为什么我的公司不见了」。 */
export async function listMySuspendedCompanies(): Promise<string[]> {
  const userId = await requireUserId();
  const rows = await withoutUserContext(
    (tx) => tx`
      select o.name from memberships m
      join organizations o on o.id = m.organization_id
      where m.user_id = ${userId} and m.status = 'suspended'
      order by o.name
    `,
  );
  return rows.map((r) => r.name as string);
}

/**
 * 按邀请 id 接受，只对发给当前登录邮箱的邀请有效。
 * 邀请 token 只以哈希存储，onboarding 拿不到原文链接，所以这里查出哈希交给
 * app_accept_invitation——后者仍会在行锁下重新校验状态与邮箱。
 */
export async function acceptInvitationById(invitationId: string): Promise<{ orgSlug: string }> {
  const userId = await requireUserId();
  // id 来自 onboarding 页面上的按钮，但这是可直接 POST 的端点：不是 uuid 的串
  // 交给 Postgres 会抛 22P02，语义上它就是「这条邀请不存在」。
  if (!idSchema.safeParse(invitationId).success) {
    throw new AuthError('not_found', 'This invitation link is not valid.');
  }

  const [invitation] = await withoutUserContext(
    (tx) => tx`
      select i.token_hash, i.organization_id, i.role, o.slug
      from invitations i
      join organizations o on o.id = i.organization_id
      join app_users u on lower(u.email) = lower(i.email)
      where i.id = ${invitationId} and u.id = ${userId}
    `,
  );
  if (!invitation) throw new AuthError('not_found', 'This invitation link is not valid.');

  return withTransaction(userId, async (tx) => {
    const rows = await tx`
      select app_accept_invitation(${invitation.token_hash as string}, ${userId}) as membership_id
    `.catch(translateDbError);

    await recordAudit(tx, {
      organizationId: invitation.organization_id as string,
      actorUserId: userId,
      action: 'membership.accepted',
      entityType: 'membership',
      entityId: rows[0].membership_id as string,
      after: { role: invitation.role },
    });

    return { orgSlug: invitation.slug as string };
  });
}

export async function changeMemberRole(
  orgSlug: string,
  membershipId: string,
  role: Role,
): Promise<void> {
  // memberRoleSchema 同时校验 membershipId 与 role，role 用 inviteRoleSchema，
  // 天然排除 owner——升为 owner 只能走 transferOwnership。
  const data = memberRoleSchema.parse({ membershipId, role });
  const context = await requirePermission(orgSlug, 'member:manage');

  await withTransaction(context.userId, async (tx) => {
    const member = await findMembership(tx, context.organizationId, data.membershipId);
    if (!member) throw new AuthError('not_found', 'That member does not exist.');
    if (member.role === 'owner') {
      throw new AuthError('forbidden', 'Use ownership transfer to change the owner.');
    }
    assertCanManage(context, member, data.role);

    await updateMembershipRole(tx, data.membershipId, data.role);
    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'membership.role_changed',
      entityType: 'membership',
      entityId: data.membershipId,
      before: { role: member.role },
      after: { role: data.role },
    });
  });

  revalidatePath(`/${orgSlug}/settings/members`);
}

export async function setMemberStatus(
  orgSlug: string,
  membershipId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  memberStatusSchema.parse({ membershipId, status });
  const context = await requirePermission(orgSlug, 'member:manage');

  await withTransaction(context.userId, async (tx) => {
    const member = await findMembership(tx, context.organizationId, membershipId);
    if (!member) throw new AuthError('not_found', 'That member does not exist.');
    if (member.role === 'owner') {
      // 允许暂停 owner 会把公司锁死：没人能再改成员或转让所有权。
      throw new AuthError('forbidden', 'The owner cannot be suspended.');
    }
    assertCanManage(context, member);

    await updateMembershipStatus(tx, membershipId, status as MembershipStatus);
    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: status === 'suspended' ? 'membership.suspended' : 'membership.reactivated',
      entityType: 'membership',
      entityId: membershipId,
      before: { status: member.status },
      after: { status },
    });
  });

  revalidatePath(`/${orgSlug}/settings/members`);
}

export async function transferOwnership(
  orgSlug: string,
  targetMembershipId: string,
): Promise<void> {
  idSchema.parse(targetMembershipId);
  const context = await requirePermission(orgSlug, 'organization:transfer');

  await withTransaction(context.userId, async (tx) => {
    const target = await findMembership(tx, context.organizationId, targetMembershipId);
    if (!target) throw new AuthError('not_found', 'That member does not exist.');
    if (target.status !== 'active') {
      throw new AuthError('forbidden', 'Only an active member can become the owner.');
    }
    if (target.role === 'owner') {
      throw new AuthError('forbidden', 'That member is already the owner.');
    }

    // 降级与提升在数据库函数里原子完成；owner 行的保护触发器只放行这条路径。
    await tx`select app_transfer_ownership(${context.organizationId}, ${targetMembershipId})`.catch(
      translateDbError,
    );

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'organization.ownership_transferred',
      entityType: 'membership',
      entityId: targetMembershipId,
      before: { ownerUserId: context.userId },
      after: { ownerUserId: target.userId },
    });
  });

  revalidatePath(`/${orgSlug}/settings/members`);
}
