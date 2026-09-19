import { ReportsView } from '@/components/reports/reports-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission, todayInOrg } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
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
  // 财年起点目前硬编码为日历年 1 月 1 日。organizations 表没有财年列，
  // 而马来西亚的中小企业财年常常不是 1 月起——这是一个已知限制，不是疏忽：
  // 加这一列要同时决定跨财年的报表默认区间、留存收益结转的时点与期初余额
  // 的归属，属于产品决定。下面所有报表函数都接受传入的期间，加上那一列之后
  // 只需要改这一行。
  const yearStart = `${today.slice(0, 4)}-01-01`;

  const { trialBalance, profitLoss, balanceSheet, cashFlow, arAging, apAging, contacts } =
    await withTransaction(context.userId, async (tx) => {
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
      />
    </>
  );
}
