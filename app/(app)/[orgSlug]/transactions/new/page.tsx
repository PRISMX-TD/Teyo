import { TransactionForm } from '@/components/transaction/transaction-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import { listCategories } from '@/server/repositories/categories';
import { getUserLocale } from '@/server/repositories/organizations';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewTransactionPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { accounts, categories } = await withTransaction(context.userId, async (tx) => ({
    accounts: await listMoneyAccounts(tx, context.organizationId),
    categories: await listCategories(tx, context.organizationId),
  }));

  const toOption = (row: { id: string; nameEn: string | null; nameZh: string | null }) => ({
    id: row.id,
    name_en: row.nameEn,
    name_zh: row.nameZh,
  });

  return (
    <>
      <h1>{t.transaction.newTitle}</h1>
      <TransactionForm
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        locale={locale}
        moneyAccounts={accounts.map(toOption)}
        incomeCategories={categories.filter((c) => c.kind === 'income').map(toOption)}
        expenseCategories={categories.filter((c) => c.kind === 'expense').map(toOption)}
        currencies={[...SUPPORTED_CURRENCIES]}
      />
    </>
  );
}
