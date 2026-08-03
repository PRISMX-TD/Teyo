import { SummaryCards } from '@/components/overview/summary-cards';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import {
  getAccountBalances,
  getExpenseByCategory,
  getMonthTotals,
} from '@/server/repositories/overview';
import { getUserLocale } from '@/server/repositories/organizations';
import { listTransactions } from '@/server/repositories/transactions';

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  const data = await withTransaction(context.userId, async (tx) => ({
    totals: await getMonthTotals(tx, context.organizationId, month),
    balances: await getAccountBalances(tx, context.organizationId, today),
    shares: await getExpenseByCategory(tx, context.organizationId, month),
    recent: await listTransactions(tx, context.organizationId, {}, { limit: 8, offset: 0 }),
  }));

  return (
    <main>
      <h1>{t.overview.title}</h1>

      <SummaryCards
        totals={data.totals}
        balances={data.balances}
        shares={data.shares}
        baseCurrency={context.baseCurrency}
        locale={locale}
      />

      <section>
        <h2>{t.overview.recentTransactions}</h2>
        {data.recent.rows.length === 0 ? <p>{t.overview.empty}</p> : null}
        <ul>
          {data.recent.rows.map((row) => (
            <li key={row.id}>
              <a href={`/${orgSlug}/transactions/${row.id}`}>
                {row.occurredOn} &middot; {row.description || '\u2014'}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
