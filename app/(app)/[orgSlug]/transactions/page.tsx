import { TransactionFilters } from '@/components/transaction/transaction-filters';
import { TransactionTable } from '@/components/transaction/transaction-table';
import Link from 'next/link';
import { getMessages, interpolate } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import { listCategories } from '@/server/repositories/categories';
import { listMembershipsByOrg } from '@/server/repositories/memberships';
import { getUserLocale } from '@/server/repositories/organizations';
import { listTransactions, type TransactionFilters as TFilters } from '@/server/repositories/transactions';

export default async function TransactionsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const raw = await searchParams;
  const filters: TFilters = {
    from: typeof raw.from === 'string' ? raw.from : undefined,
    to: typeof raw.to === 'string' ? raw.to : undefined,
    kind: typeof raw.kind === 'string' ? (raw.kind as 'income' | 'expense' | 'transfer' | 'journal') : undefined,
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : undefined,
    moneyAccountId: typeof raw.moneyAccountId === 'string' ? raw.moneyAccountId : undefined,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : undefined,
    minAmount: typeof raw.minAmount === 'string' ? raw.minAmount : undefined,
    maxAmount: typeof raw.maxAmount === 'string' ? raw.maxAmount : undefined,
    keyword: typeof raw.keyword === 'string' ? raw.keyword : undefined,
    includeVoided: raw.includeVoided === 'true',
  };

  const PAGE_SIZE = 50;
  const pageParam = Number(raw.page ?? '1');
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // 保留除 page 以外的全部查询参数，翻页时筛选条件不丢。
  // searchParams 的值可能是 string[]（重复参数），只取第一个。
  const currentQuery: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'page' || value === undefined) continue;
    currentQuery[key] = Array.isArray(value) ? value[0] : value;
  }

  const data = await withTransaction(context.userId, async (tx) => {
    const [accounts, categories, members, transactions] = await Promise.all([
      listMoneyAccounts(tx, context.organizationId),
      listCategories(tx, context.organizationId),
      listMembershipsByOrg(tx, context.organizationId),
      listTransactions(tx, context.organizationId, filters, { limit: PAGE_SIZE + 1, offset }),
    ]);
    return { accounts, categories, members, transactions };
  });

  const hasNextPage = data.transactions.rows.length > PAGE_SIZE;
  const pageRows = hasNextPage ? data.transactions.rows.slice(0, PAGE_SIZE) : data.transactions.rows;

  const toOption = (row: { id: string; nameEn: string | null; nameZh: string | null }) => ({
    id: row.id,
    name_en: row.nameEn,
    name_zh: row.nameZh,
  });

  return (
    <>
      <div className="page-header">
        <h1>{t.transaction.listTitle}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/transactions/new`} className="primary-button">
            {t.transaction.newTitle}
          </Link>
          <Link href={`/${orgSlug}/transactions/journal`} className="primary-button">
            {t.journal.newTitle}
          </Link>
        </div>
      </div>

      <TransactionFilters
        orgSlug={orgSlug}
        locale={locale}
        categories={data.categories.map((c) => toOption(c as unknown as { id: string; nameEn: string | null; nameZh: string | null }))}
        moneyAccounts={data.accounts.map(toOption)}
        members={data.members.map((m) => ({ userId: m.userId, displayName: m.displayName }))}
      />

      <TransactionTable
        orgSlug={orgSlug}
        rows={pageRows}
        locale={locale}
        baseCurrency={context.baseCurrency}
        emptyLabel={t.transaction.empty}
      />

      <nav className="pagination" aria-label={t.transaction.pagination}>
        {page > 1 ? (
          <Link
            className="secondary-button"
            href={`/${orgSlug}/transactions?${new URLSearchParams({
              ...currentQuery,
              page: String(page - 1),
            })}`}
          >
            {t.common.previous}
          </Link>
        ) : null}
        <span className="pagination-page">{interpolate(t.common.pageN, { page })}</span>
        {hasNextPage ? (
          <Link
            className="secondary-button"
            href={`/${orgSlug}/transactions?${new URLSearchParams({
              ...currentQuery,
              page: String(page + 1),
            })}`}
          >
            {t.common.next}
          </Link>
        ) : null}
      </nav>
    </>
  );
}
