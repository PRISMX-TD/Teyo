import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { resolveOrgContext } from '@/server/auth/guard';
import { can, type Action } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';

export default async function SettingsIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await resolveOrgContext(orgSlug);
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 侧栏的「设置」指向这里，所以这一页必须存在；它只是分流，不做任何写操作。
  const sections: Array<{ href: string; label: string; action: Action }> = [
    { href: 'general', label: t.settings.general, action: 'account:manage' },
    { href: 'members', label: t.settings.members, action: 'member:manage' },
    { href: 'categories', label: t.settings.categories, action: 'category:manage' },
    { href: 'accounts', label: t.settings.accounts, action: 'account:manage' },
    { href: 'recurring', label: t.settings.recurring, action: 'transaction:create' },
    { href: 'contacts', label: t.settings.contacts, action: 'account:manage' },
    { href: 'audit', label: t.settings.audit, action: 'report:export' },
  ];

  const visible = sections.filter((section) => can(context.role, section.action));

  return (
    <>
      <h1>{t.nav.settings}</h1>

      <nav className="settings-index">
        {visible.map((section) => (
          <Link key={section.href} href={`/${orgSlug}/settings/${section.href}`}>
            {section.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
