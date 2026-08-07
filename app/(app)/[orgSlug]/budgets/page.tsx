import { BudgetView } from '@/components/budgets/budget-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
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

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

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
