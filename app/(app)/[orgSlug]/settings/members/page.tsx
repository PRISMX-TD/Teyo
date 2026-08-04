import { MembersPanel } from '@/components/settings/members-panel';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { listPendingInvitations } from '@/server/repositories/invitations';
import { listMembershipsByOrg } from '@/server/repositories/memberships';
import { getUserLocale } from '@/server/repositories/organizations';

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
      <h1>{t.members.title}</h1>
      <MembersPanel
        orgSlug={orgSlug}
        members={members}
        invitations={invitations}
        currentUserId={context.userId}
        locale={locale}
      />
    </>
  );
}
