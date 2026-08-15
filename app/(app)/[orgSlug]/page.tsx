import { DashboardView } from '@/components/dashboard/dashboard-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import {
  getDashboardKpis,
  getMonthlyTrends,
  getExpenseByCategory,
  getBankBalances,
} from '@/server/repositories/dashboard';
import { getUserLocale } from '@/server/repositories/organizations';

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const { kpis, trends, expenses, balances } = await withTransaction(
    context.userId,
    async (tx) => {
      const [kpis, trends, expenses, balances] = await Promise.all([
        getDashboardKpis(tx, context.organizationId),
        getMonthlyTrends(tx, context.organizationId),
        getExpenseByCategory(tx, context.organizationId, year, month),
        getBankBalances(tx, context.organizationId),
      ]);
      return { kpis, trends, expenses, balances };
    },
  );

  return (
    <>
      <h1>{t.overview.title}</h1>
      <DashboardView
        kpis={kpis}
        trends={trends}
        expenses={expenses}
        balances={balances}
        locale={locale}
        baseCurrency={context.baseCurrency}
        orgSlug={orgSlug}
        i18n={t}
      />
    </>
  );
}
