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
import { transactionFilterSchema } from '@/lib/schemas';
import { listTransactions, type TransactionFilters as TFilters } from '@/server/repositories/transactions';

/** searchParams 的值可能是 string[]（重复参数），统一只取第一个。 */
function first(value: string | string[] | undefined): string | undefined {
  const single = Array.isArray(value) ? value[0] : value;
  // 空串（?categoryId= ）在 zod 里会是一个格式错误的 uuid，而它的语义其实
  // 是「这一项没填」——先归一成 undefined，不然清空一个筛选框就会把整组
  // 筛选判成非法。
  return single === '' ? undefined : single;
}

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

  /**
   * 筛选条件过 transactionFilterSchema。
   *
   * 这个 schema 一直在 lib/schemas.ts 里定义着、也有测试，但生产路径上
   * 一条都没执行过——这一页原来只做 `typeof x === 'string'` 判断，然后把
   * 地址栏里的任何东西原样送进 SQL 参数。参数是绑定的（postgres.js 模板
   * 标签），所以不是注入；但 `?categoryId=not-a-uuid` 会让数据库抛一个
   * 22P02 类型错误，用户看到的是整页 500，而不是「这个筛选不对」。
   *
   * 用 safeParse 而不是 parse：一个手敲坏的链接不该把整页打挂。失败时
   * 退回「不筛选」并在页面上说明，列表照常显示——这比一个错误页更接近
   * 用户当时想要的东西（他想看这家公司的流水）。
   */
  const parsedFilters = transactionFilterSchema.safeParse({
    from: first(raw.from),
    to: first(raw.to),
    kind: first(raw.kind),
    categoryId: first(raw.categoryId),
    moneyAccountId: first(raw.moneyAccountId),
    createdBy: first(raw.createdBy),
    minAmount: first(raw.minAmount),
    maxAmount: first(raw.maxAmount),
    keyword: first(raw.keyword),
    includeVoided: first(raw.includeVoided) === 'true',
    page: first(raw.page) ?? 1,
  });

  const filters: TFilters = parsedFilters.success
    ? {
        from: parsedFilters.data.from,
        to: parsedFilters.data.to,
        kind: parsedFilters.data.kind,
        categoryId: parsedFilters.data.categoryId,
        moneyAccountId: parsedFilters.data.moneyAccountId,
        createdBy: parsedFilters.data.createdBy,
        minAmount: parsedFilters.data.minAmount,
        maxAmount: parsedFilters.data.maxAmount,
        keyword: parsedFilters.data.keyword,
        includeVoided: parsedFilters.data.includeVoided,
      }
    : { includeVoided: false };

  const PAGE_SIZE = 50;
  const page = parsedFilters.success ? parsedFilters.data.page : 1;
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
        {/* 两个动作，一个主一个次。原来两个都是 primary-button——并排两块
            同样醒目的实色，用户没有被告知该先看哪一个。「记一笔」是这个
            产品的主路径（PRODUCT.md：用户只做收入/支出/转账三种动作），
            「记账凭证」是懂复式记账的人才会走的旁路。 */}
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/transactions/new`} className="primary-button">
            {t.transaction.newTitle}
          </Link>
          <Link href={`/${orgSlug}/transactions/journal`} className="secondary-button">
            {t.journal.newTitle}
          </Link>
        </div>
      </div>

      <TransactionFilters
        orgSlug={orgSlug}
        locale={locale}
        categories={data.categories.map(toOption)}
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
