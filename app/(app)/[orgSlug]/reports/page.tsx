import { ReportsView } from '@/components/reports/reports-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission, todayInOrg } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getFiscalYearStartMonth, getUserLocale } from '@/server/repositories/organizations';
import { fiscalYearFor } from '@/server/services/year-end-close';
import { getTrialBalance, getProfitLoss, getBalanceSheet, getCashFlow } from '@/server/repositories/reports';
import { getArAging, getApAging } from '@/server/repositories/aging';
import { listContacts } from '@/server/repositories/contacts';

export default async function ReportsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 按公司时区算，不是服务端的 UTC——Vercel 的运行时 TZ 就是 UTC，对一家
  // UTC+8 的公司，每天本地 00:00–08:00 这八小时里报表的截止日会是昨天。
  const today = todayInOrg(context);

  const { trialBalance, profitLoss, balanceSheet, cashFlow, arAging, apAging, contacts, period } =
    await withTransaction(context.userId, async (tx) => {
      // 财年起点不再硬编码成 1 月 1 日。马来西亚的中小企业财年常常不是
      // 1 月起，而这个日期决定损益表与现金流量表的期间；差一个月，整张
      // 损益表就是错的期间，而它看起来完全正常。
      //
      // 更要紧的是它与年结的关系：资产负债表的 currentYearEarnings 必须
      // 只含**本财年至今**的损益。已经结转过的年度，利润在 retained-earnings
      // 里、被 equityTotal 算进去了；如果这里仍按日历年取期间，财年 7 月起
      // 的公司会把 1–6 月那半年同时算进权益与本年利润，资产负债表恰好多出
      // 半年利润（I5 当场变红）。见 getBalanceSheet 的注释。
      const startMonth = await getFiscalYearStartMonth(tx, context.organizationId);
      const fiscalYear = fiscalYearFor(today, startMonth);
      const yearStart = fiscalYear.start;

      const [trial, pl, ar, ap, contactList] = await Promise.all([
        getTrialBalance(tx, context.organizationId, today),
        getProfitLoss(tx, context.organizationId, yearStart, today),
        getArAging(tx, context.organizationId, today),
        getApAging(tx, context.organizationId, today),
        listContacts(tx, context.organizationId),
      ]);
      const bs = await getBalanceSheet(tx, context.organizationId, today, pl.netIncome);
      const cf = await getCashFlow(tx, context.organizationId, yearStart, today);
      return {
        trialBalance: trial,
        profitLoss: pl,
        balanceSheet: bs,
        cashFlow: cf,
        arAging: ar,
        apAging: ap,
        contacts: contactList,
        period: { from: yearStart, to: today },
      };
    });

  return (
    <>
      <div className="page-header">
        <h1>{t.reports.title}</h1>
      </div>
      <ReportsView
        locale={locale}
        baseCurrency={context.baseCurrency}
        t={t}
        trialBalance={trialBalance}
        profitLoss={profitLoss}
        balanceSheet={balanceSheet}
        cashFlow={cashFlow}
        arAging={arAging}
        apAging={apAging}
        contacts={contacts}
        orgSlug={orgSlug}
        period={period}
      />
    </>
  );
}
