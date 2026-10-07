import { BudgetView } from '@/components/budgets/budget-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission, todayInOrg } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getBudgetVsActual } from '@/server/repositories/budgets';
import { updateBudget } from '@/server/actions/budgets';

export default async function BudgetsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 公司时区下的本月，不是服务端 UTC 的本月（见 server/auth/guard.ts 的 todayInOrg）。
  const today = todayInOrg(context);
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));

  return (
    <>
      <div className="page-header">
        <h1>{t.budgets.title}</h1>
      </div>
      <BudgetView
        orgSlug={orgSlug}
        locale={locale}
        baseCurrency={context.baseCurrency}
        t={t}
        initialYear={currentYear}
        initialMonth={currentMonth}
        updateBudgetAction={updateBudget}
        loadData={async (year: number, month: number) => {
          'use server';
          const ctx = await requirePermission(orgSlug, 'account:manage');
          const rows = await withTransaction(ctx.userId, (tx) =>
            getBudgetVsActual(tx, ctx.organizationId, year, month),
          );
          return rows.map((r) => ({
            accountId: r.accountId,
            accountCode: r.accountCode,
            accountNameEn: r.accountNameEn,
            accountNameZh: r.accountNameZh,
            accountType: r.accountType,
            isMoneyAccount: r.isMoneyAccount,
            budgetMinor: String(r.budgetMinor),
            actualMinor: String(r.actualMinor),
            varianceMinor: String(r.varianceMinor),
          }));
        }}
      />
    </>
  );
}
