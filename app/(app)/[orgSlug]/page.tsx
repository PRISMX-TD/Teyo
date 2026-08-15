import { DashboardView } from '@/components/dashboard/dashboard-view';
import type { ChecklistState } from '@/components/dashboard/first-run-checklist';
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

  const { kpis, trends, expenses, balances, checklist } = await withTransaction(
    context.userId,
    async (tx) => {
      const [
        kpis,
        trends,
        expenses,
        balances,
        moneyAccountRows,
        firstTransactionRows,
        contactRows,
        invitationRows,
      ] = await Promise.all([
        getDashboardKpis(tx, context.organizationId),
        getMonthlyTrends(tx, context.organizationId),
        getExpenseByCategory(tx, context.organizationId, year, month),
        getBankBalances(tx, context.organizationId),
        // 每家新公司都自带 cash/bank 两个种子科目，is_money_account 天生为真——
        // 光看这个会让第一项从第一天起就是已完成、毫无意义。这里改问
        // "用户自己配置过资金账户吗"：is_system = false 只在用户新建科目时
        // 才为假（seedChartOfAccounts 写入的种子科目一律 is_system = true，
        // insertAccount 新建的科目一律 is_system = false），不会被种子数据本身满足。
        tx`
          select exists(
            select 1 from accounts
            where organization_id = ${context.organizationId}
              and is_money_account = true
              and is_system = false
              and is_active = true
          ) as done
        `,
        tx`
          select exists(
            select 1 from transactions
            where organization_id = ${context.organizationId}
              and kind in ('income', 'expense')
              and voided_at is null
          ) as done
        `,
        tx`
          select exists(
            select 1 from contacts
            where organization_id = ${context.organizationId}
          ) as done
        `,
        tx`
          select exists(
            select 1 from invitations
            where organization_id = ${context.organizationId}
          ) as done
        `,
      ]);

      const checklist: ChecklistState = {
        hasMoneyAccount: Boolean(moneyAccountRows[0]?.done),
        hasFirstTransaction: Boolean(firstTransactionRows[0]?.done),
        hasContact: Boolean(contactRows[0]?.done),
        hasInvitedSomeone: Boolean(invitationRows[0]?.done),
      };

      return { kpis, trends, expenses, balances, checklist };
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
      />
    </>
  );
}
