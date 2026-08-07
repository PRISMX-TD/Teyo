import { ReconciliationView } from '@/components/reconciliation/reconciliation-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import {
  listReconciliations,
  listUnreconciledTransactions,
  getBookBalance,
} from '@/server/repositories/reconciliation';
import { reconcile } from '@/server/actions/reconciliation';

export default async function ReconciliationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:edit:any');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const moneyAccounts = await withTransaction(context.userId, (tx) =>
    listMoneyAccounts(tx, context.organizationId),
  );

  return (
    <>
      <div className="page-header">
        <h1>{t.reconciliation.title}</h1>
      </div>
      <ReconciliationView
        orgSlug={orgSlug}
        locale={locale}
        baseCurrency={context.baseCurrency}
        t={t}
        moneyAccounts={moneyAccounts}
        reconcileAction={reconcile}
        loadData={async (moneyAccountId: string) => {
          'use server';
          const ctx = await requirePermission(orgSlug, 'transaction:edit:any');
          const result = await withTransaction(ctx.userId, async (tx) => {
            const [txns, past, bookBalance] = await Promise.all([
              listUnreconciledTransactions(tx, ctx.organizationId, moneyAccountId),
              listReconciliations(tx, ctx.organizationId, moneyAccountId),
              getBookBalance(tx, ctx.organizationId, moneyAccountId),
            ]);
            return {
              txns: txns.map((t) => ({ ...t, amountMinor: String(t.amountMinor) })),
              past: past.map((p) => ({
                id: p.id,
                statementDate: p.statementDate,
                statementBalanceMinor: String(p.statementBalanceMinor),
                reconciledAt: p.reconciledAt,
              })),
              bookBalance: String(bookBalance),
            };
          });
          return result;
        }}
      />
    </>
  );
}
