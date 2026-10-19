import { BackLink } from '@/components/ui/back-link';
import { ImportForm } from '@/components/bank-import/import-form';
import { ImportedList } from '@/components/bank-import/imported-list';
import { getMessages } from '@/lib/i18n';
import { requirePermission, requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import { listImportedTransactions } from '@/server/repositories/bank-import';
import { listSelectableCategories } from '@/server/repositories/categories';
import { listTransactions } from '@/server/repositories/transactions';
import type { TransactionListRow } from '@/server/repositories/transactions';

export default async function BankImportPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePagePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const i18n = getMessages(locale);

  // 资金账户、已导入流水、两个方向的分类：互不依赖，一个事务里一起查。
  // 原来是三次独立事务串行。
  const [moneyAccountsRaw, importedTxns, incomeCategories, expenseCategories] =
    await withTransaction(context.userId, (tx) =>
      Promise.all([
        listMoneyAccounts(tx, context.organizationId),
        listImportedTransactions(tx, context.organizationId),
        listSelectableCategories(tx, context.organizationId, 'income'),
        listSelectableCategories(tx, context.organizationId, 'expense'),
      ]),
    );
  const moneyAccounts = moneyAccountsRaw.map((a) => ({
    id: a.id,
    name_en: a.nameEn,
    name_zh: a.nameZh,
  }));

  /**
   * 生成交易时能选的分类。
   *
   * 走 listSelectableCategories 而不是 listCategories：后者会把折旧、摊销
   * 这类「只该由系统过账」的分类也列出来（见 categories.ts 上那段注释）。
   * 一个小白把一笔银行扣款配成「折旧」，生成的是一笔贷记资金账户的分录，
   * 与固定资产模块的折旧过账重复计算——而两笔都各自配平，谁也看不出来。
   *
   * 两个方向都要：一行流水是收入还是支出由金额的正负决定，而这份列表在
   * 客户端按符号过滤（见 ImportedList）。在这里只查一种，另一半流水就选
   * 不到任何分类。
   */
  const categories = [...incomeCategories, ...expenseCategories].map((c) => ({
    id: c.id,
    nameEn: c.nameEn,
    nameZh: c.nameZh,
    kind: c.kind as 'income' | 'expense',
  }));

  return (
    <>
      {/* 手机上这一页是从「更多」推进来的，装成 PWA 后没有浏览器返回键。
          桌面上侧栏一直在，不需要它（见 tx.css 的 .bank-import-back）。 */}
      <div className="bank-import-back">
        <BackLink href={`/${orgSlug}/more`}>{i18n.nav.more}</BackLink>
      </div>
      <div className="page-header">
        <h1>{i18n.bankImport.title}</h1>
      </div>

      <ImportForm
        orgSlug={orgSlug}
        locale={locale}
        i18n={i18n}
        moneyAccounts={moneyAccounts}
      />

      <ImportedList
        orgSlug={orgSlug}
        locale={locale}
        i18n={i18n}
        importedTxns={importedTxns}
        moneyAccounts={moneyAccounts}
        baseCurrency={context.baseCurrency}
        categories={categories}
        searchTxns={async (query: string) => {
          'use server';
          const ctx = await requirePermission(orgSlug, 'transaction:read');
          const result = await withTransaction(ctx.userId, async (tx) => {
            const { rows } = await listTransactions(
              tx,
              ctx.organizationId,
              { keyword: query, includeVoided: false },
              { limit: 10, offset: 0 },
            );
            return rows.map((r: TransactionListRow) => ({
              id: r.id,
              description: r.description,
              occurredOn: r.occurredOn,
              amountMinor: String(r.amountMinor),
            }));
          });
          return result;
        }}
      />
    </>
  );
}
