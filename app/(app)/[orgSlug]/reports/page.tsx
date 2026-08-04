import { ReportsView } from '@/components/reports/reports-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getTrialBalance, getProfitLoss, getBalanceSheet, getCashFlow } from '@/server/repositories/reports';

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 默认截止到今天，期间为本年度
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = `${new Date().getFullYear()}-01-01`;

  const { trialBalance, profitLoss, balanceSheet, cashFlow } = await withTransaction(
    context.userId,
    async (tx) => {
      const [trial, pl] = await Promise.all([
        getTrialBalance(tx, context.organizationId, today),
        getProfitLoss(tx, context.organizationId, yearStart, today),
      ]);
      // 资产负债表需要当期净利润
      const bs = await getBalanceSheet(tx, context.organizationId, today, pl.netIncome);
      const cf = await getCashFlow(tx, context.organizationId, yearStart, today);
      return { trialBalance: trial, profitLoss: pl, balanceSheet: bs, cashFlow: cf };
    },
  );

  return (
    <>
      <h1>{t.reports.title}</h1>
      <ReportsView
        locale={locale}
        baseCurrency={context.baseCurrency}
        t={t}
        trialBalance={trialBalance}
        profitLoss={profitLoss}
        balanceSheet={balanceSheet}
        cashFlow={cashFlow}
      />
    </>
  );
}
