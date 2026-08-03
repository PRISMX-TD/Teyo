import { MembersPanel } from '@/components/settings/members-panel';
import { getMessages } from '@/lib/i18n';
import { listInvitations, listMembers } from '@/server/actions/members';
import { requirePermission } from '@/server/auth/guard';
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

  const [members, invitations] = await Promise.all([
    listMembers(orgSlug),
    listInvitations(orgSlug),
  ]);

  return (
    <main>
      <h1>{t.members.title}</h1>
      <MembersPanel
        orgSlug={orgSlug}
        members={members}
        invitations={invitations}
        currentUserId={context.userId}
        locale={locale}
      />
    </main>
  );
}
