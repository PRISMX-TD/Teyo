import { BackLink } from '@/components/ui/back-link';
import { Plus } from '@/components/ui/icons';
import { NamedList } from '@/components/settings/named-list';
import { getMessages } from '@/lib/i18n';
import { createCategoryFromNamedList, renameCategory, setCategoryActive } from '@/server/actions/categories';
import { requirePagePermission } from '@/server/auth/guard';
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
  const context = await requirePagePermission(orgSlug, 'category:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 一个事务、两条并发：原来是两次独立事务串行，各自一轮 begin / set role / commit。
  const [categories, accounts] = await withTransaction(context.userId, (tx) =>
    Promise.all([
      listAllCategories(tx, context.organizationId),
      listAllAccounts(tx, context.organizationId),
    ]),
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
      <BackLink href={`/${orgSlug}/settings`}>{t.nav.settings}</BackLink>
      {/* 新增表单在十几行分类的最下面；页头给一个跳过去的入口。 */}
      <div className="page-header">
        <h1>{t.settings.categories}</h1>
        <div className="page-header-actions">
          <a href="#add-category" className="add-button">
            <Plus size={16} weight="bold" aria-hidden="true" />
            {t.settings.addCategory}
          </a>
        </div>
      </div>
      <NamedList
        addFormId="add-category"
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
