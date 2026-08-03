'use server';

import { revalidatePath } from 'next/cache';
import { inviteMemberSchema, memberRoleSchema } from '@/lib/schemas';
import { AuthError, requirePermission, requireUserId } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import type { MembershipStatus, Role } from '@/server/domain/permissions';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  acceptInvitationByToken,
  findInvitationByToken,
  generateInvitationToken,
  insertInvitation,
  listPendingInvitations,
  markInvitationRevoked,
  type InvitationRow,
} from '@/server/repositories/invitations';
import {
  findMembership,
  findOwnerMembershipId,
  listMembershipsByOrg,
  updateMembershipRole,
  updateMembershipStatus,
  type MemberRow,
} from '@/server/repositories/memberships';

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
  const { token, tokenHash } = generateInvitationToken();

  await withTransaction(context.userId, async (tx) => {
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
    const membershipId = await acceptInvitationByToken(tx, token, userId);

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
  const context = await requirePermission(orgSlug, 'member:manage');

  await withTransaction(context.userId, async (tx) => {
    const member = await findMembership(tx, context.organizationId, membershipId);
    if (!member) throw new AuthError('not_found', 'That member does not exist.');
    if (member.role === 'owner') {
      // 允许暂停 owner 会把公司锁死：没人能再改成员或转让所有权。
      throw new AuthError('forbidden', 'The owner cannot be suspended.');
    }

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

    const currentOwnerId = await findOwnerMembershipId(tx, context.organizationId);
    if (!currentOwnerId) {
      throw new AuthError('not_found', 'This company has no owner to transfer from.');
    }

    // 唯一索引 memberships_single_owner 要求先腾出 owner 位置，顺序不能颠倒。
    await updateMembershipRole(tx, currentOwnerId, 'admin');
    await updateMembershipRole(tx, targetMembershipId, 'owner');

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
