import Link from 'next/link';
import { NamedList } from '@/components/settings/named-list';
import { getMessages } from '@/lib/i18n';
import { createCategoryFromNamedList, renameCategory, setCategoryActive } from '@/server/actions/categories';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listAllCategories } from '@/server/repositories/categories';
import { listAllAccounts } from '@/server/repositories/accounts';

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

  const accounts = await withTransaction(context.userId, (tx) =>
    listAllAccounts(tx, context.organizationId),
  );

  const items = categories.map((c) => ({
    id: c.id,
    nameEn: c.nameEn,
    nameZh: c.nameZh,
    isActive: c.isActive,
    kind: c.kind,
  }));

  const incomeAccounts = accounts
    .filter((a) => a.type === 'revenue' && a.isActive)
    .map((a) => ({ id: a.id, nameEn: a.nameEn, nameZh: a.nameZh }));
  const expenseAccounts = accounts
    .filter((a) => a.type === 'expense' && a.isActive)
    .map((a) => ({ id: a.id, nameEn: a.nameEn, nameZh: a.nameZh }));

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
        categoryOptions={{ incomeAccounts, expenseAccounts }}
        onCreate={createCategoryFromNamedList}
        onRename={renameCategory}
        onToggle={setCategoryActive}
      />
    </>
  );
}
