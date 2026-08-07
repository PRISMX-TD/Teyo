import { ImportForm } from '@/components/bank-import/import-form';
import { ImportedList } from '@/components/bank-import/imported-list';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import { listImportedTransactions } from '@/server/repositories/bank_import';
import { listTransactions } from '@/server/repositories/transactions';
import type { TransactionListRow } from '@/server/repositories/transactions';

export default async function BankImportPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const i18n = getMessages(locale);

  const moneyAccountsRaw = await withTransaction(context.userId, (tx) =>
    listMoneyAccounts(tx, context.organizationId),
  );
  const moneyAccounts = moneyAccountsRaw.map((a) => ({
    id: a.id,
    name_en: a.nameEn,
    name_zh: a.nameZh,
  }));

  const importedTxns = await withTransaction(context.userId, (tx) =>
    listImportedTransactions(tx, context.organizationId),
  );

  return (
    <>
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
