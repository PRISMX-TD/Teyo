import { TransactionFilters } from '@/components/transaction/transaction-filters';
import { TransactionTable } from '@/components/transaction/transaction-table';
import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
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

  const data = await withTransaction(context.userId, async (tx) => {
    const [accounts, categories, members, transactions] = await Promise.all([
      listMoneyAccounts(tx, context.organizationId),
      listCategories(tx, context.organizationId),
      listMembershipsByOrg(tx, context.organizationId),
      listTransactions(tx, context.organizationId, filters, { limit: 50, offset: 0 }),
    ]);
    return { accounts, categories, members, transactions };
  });

  const toOption = (row: { id: string; nameEn: string | null; nameZh: string | null }) => ({
    id: row.id,
    name_en: row.nameEn,
    name_zh: row.nameZh,
  });

  return (
    <>
      <h1>{t.transaction.listTitle}</h1>
      <Link href={`/${orgSlug}/transactions/new`} className="primary-button">
        {t.transaction.newTitle}
      </Link>
      <Link href={`/${orgSlug}/transactions/journal`} className="primary-button">
        {t.journal.newTitle}
      </Link>

      <TransactionFilters
        orgSlug={orgSlug}
        locale={locale}
        categories={data.categories.map((c) => toOption(c as unknown as { id: string; nameEn: string | null; nameZh: string | null }))}
        moneyAccounts={data.accounts.map(toOption)}
        members={data.members.map((m) => ({ userId: m.userId, displayName: m.displayName }))}
      />

      <TransactionTable
        orgSlug={orgSlug}
        rows={data.transactions.rows}
        locale={locale}
        baseCurrency={context.baseCurrency}
        emptyLabel={t.transaction.empty}
      />
    </>
  );
}
