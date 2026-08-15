import { DashboardView } from '@/components/dashboard/dashboard-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import {
  getDashboardKpis,
  getMonthlyTrends,
  getExpenseByCategory,
  getBankBalances,
  getFirstRunChecklistState,
} from '@/server/repositories/dashboard';
import { getUserLocale } from '@/server/repositories/organizations';
import { countUncertain } from '@/server/repositories/uncertain';

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

  // getFirstRunChecklistState 折进这同一个 Promise.all、同一个事务——它内部
  // 按角色权限决定四项存在性查询各查不查（详见该函数上的注释），不额外开
  // 事务、也不多一次网络往返。
  const { kpis, trends, expenses, balances, checklist, uncertainCount } = await withTransaction(
    context.userId,
    async (tx) => {
      const [kpis, trends, expenses, balances, checklist, uncertainCount] = await Promise.all([
        getDashboardKpis(tx, context.organizationId),
        getMonthlyTrends(tx, context.organizationId),
        getExpenseByCategory(tx, context.organizationId, year, month),
        getBankBalances(tx, context.organizationId),
        getFirstRunChecklistState(tx, context.organizationId, context.role),
        countUncertain(tx, context.organizationId),
      ]);
      return { kpis, trends, expenses, balances, checklist, uncertainCount };
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
        checklist={checklist}
        role={context.role}
        uncertainCount={uncertainCount}
      />
    </>
  );
}
