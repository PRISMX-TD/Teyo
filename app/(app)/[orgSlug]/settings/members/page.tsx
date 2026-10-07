import Link from 'next/link';
import { ZodError } from 'zod';
import { MembersPanel, type MemberActionResult } from '@/components/settings/members-panel';
import { getMessages } from '@/lib/i18n';
import { firstIssueMessage } from '@/lib/schemas';
import { AuthError, requirePermission } from '@/server/auth/guard';
import {
  changeMemberRole,
  inviteMember,
  revokeInvitation,
  setMemberStatus,
  transferOwnership,
} from '@/server/actions/members';
import type { Role } from '@/server/domain/permissions';
import { withTransaction } from '@/server/db/transaction';
import { listPendingInvitations } from '@/server/repositories/invitations';
import { listMembershipsByOrg } from '@/server/repositories/memberships';
import { getUserLocale } from '@/server/repositories/organizations';

/**
 * 把成员 action 的「预期内失败」变成返回值。
 *
 * 生产构建会把 Server Action 抛出的异常换成一句脱敏摘要，客户端拿不到
 * message——原来面板里 catch 到的永远是那句摘要，「此人已是成员」「只有
 * owner 能管理 admin」这些提示一条都到不了用户眼前。AuthError（含
 * translateDbError 转出来的）与 ZodError 是写给用户看的，原样返回；
 * 其余仍然抛出，交给 error boundary。
 */
async function toResult<T>(run: () => Promise<T>): Promise<MemberActionResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: firstIssueMessage(err) };
    throw err;
  }
}

export default async function MembersSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'member:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 直调 repository 合并为一个事务，避免 listMembers/listInvitations 各自再鉴权一次
  const [members, invitations] = await withTransaction(context.userId, async (tx) =>
    Promise.all([
      listMembershipsByOrg(tx, context.organizationId),
      listPendingInvitations(tx, context.organizationId),
    ]),
  );

  return (
    <>
      <Link href={`/${orgSlug}/settings`} className="back-link">
        &larr; {t.nav.settings}
      </Link>
      <h1>{t.members.title}</h1>
      <MembersPanel
        members={members}
        invitations={invitations}
        currentUserId={context.userId}
        locale={locale}
        actions={{
          invite: async (input: { email: string; role: Role }) => {
            'use server';
            return toResult(() => inviteMember(orgSlug, input));
          },
          changeRole: async (membershipId: string, role: Role) => {
            'use server';
            return toResult(() => changeMemberRole(orgSlug, membershipId, role));
          },
          setStatus: async (membershipId: string, status: 'active' | 'suspended') => {
            'use server';
            return toResult(() => setMemberStatus(orgSlug, membershipId, status));
          },
          revoke: async (invitationId: string) => {
            'use server';
            return toResult(() => revokeInvitation(orgSlug, invitationId));
          },
          transfer: async (membershipId: string) => {
            'use server';
            return toResult(() => transferOwnership(orgSlug, membershipId));
          },
        }}
      />
    </>
  );
}
