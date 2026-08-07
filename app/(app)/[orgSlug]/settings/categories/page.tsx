import Link from 'next/link';
import { NamedList } from '@/components/settings/named-list';
import { getMessages } from '@/lib/i18n';
import { createCategory, renameCategory, setCategoryActive } from '@/server/actions/categories';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listAllCategories } from '@/server/repositories/categories';

export default async function CategoriesSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'category:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const categories = await withTransaction(context.userId, (tx) =>
    listAllCategories(tx, context.organizationId),
  );

  const items = categories.map((c) => ({
    id: c.id,
    nameEn: c.nameEn,
    nameZh: c.nameZh,
    isActive: c.isActive,
    kind: c.kind,
  }));

  return (
    <>
      <Link href={`/${orgSlug}/settings`} style={{ display: 'inline-block', marginBottom: 'var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        &larr; {locale === 'zh' ? '设置' : 'Settings'}
      </Link>
      <h1>{t.settings.categories}</h1>
      <NamedList
        orgSlug={orgSlug}
        items={items}
        locale={locale}
        onCreate={createCategory as unknown as (orgSlug: string, payload: Record<string, unknown>) => Promise<unknown>}
        onRename={renameCategory as unknown as (orgSlug: string, id: string, names: Record<string, string>) => Promise<unknown>}
        onToggle={setCategoryActive as unknown as (orgSlug: string, id: string, active: boolean) => Promise<unknown>}
      />
    </>
  );
}
