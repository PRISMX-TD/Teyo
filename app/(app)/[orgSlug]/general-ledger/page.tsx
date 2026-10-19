import { GeneralLedgerView } from '@/components/reports/general-ledger-view';
import { getMessages } from '@/lib/i18n';
import { todayInOrg, requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getFiscalYearStartMonth, getUserLocale } from '@/server/repositories/organizations';
import { fiscalYearFor } from '@/server/services/year-end-close';
import { listAllAccounts } from '@/server/repositories/accounts';
import { getGeneralLedger } from '@/server/repositories/reports';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isIsoDate(value: string | undefined): value is string {
  if (value === undefined || !ISO_DATE.test(value)) return false;
  // 往返一遍挡住 2026-02-30 这种格式对、日历上不存在的日期（Postgres 会拒绝）。
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export default async function GeneralLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const context = await requirePagePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 按公司时区，不是服务端 UTC（见 server/auth/guard.ts 的 todayInOrg）。
  const today = todayInOrg(context);
  // 查询串是用户可以随手改的地址栏：一个不像日期的 from/to、或者不像 uuid
  // 的 account，原样进 SQL 只会让 Postgres 抛类型错误、整页 500。不合法的
  // 当作没传，退回默认值。
  const to = isIsoDate(sp.to) ? sp.to : today;
  const accountId = sp.account && UUID.test(sp.account) ? sp.account : undefined;

  const { accounts, ledger, from } = await withTransaction(context.userId, async (tx) => {
    // 默认起点是**本财年**的第一天，不再是 `${year}-01-01`。总账最常被打开
    // 的一次是「看看 retained-earnings 这个科目到底是怎么来的」，而年结分录
    // 落在财年最后一天——按日历年取默认区间的话，7 月起的公司打开总账，
    // 默认区间正好把上一次年结排除在外，那个科目的余额没有任何一行解释得了。
    // 两条互不依赖，同一条连接上流水线发出。
    const [startMonth, allAccts] = await Promise.all([
      getFiscalYearStartMonth(tx, context.organizationId),
      listAllAccounts(tx, context.organizationId),
    ]);
    const defaultFrom = fiscalYearFor(today, startMonth).start;
    const resolvedFrom = isIsoDate(sp.from) ? sp.from : defaultFrom;

    // 当前选中的科目即便已归档也留在下拉里：归档科目照样有历史分录可查，
    // 选项里没有它的话，下拉显示的是「选择科目…」，与下面那张账对不上。
    const options = allAccts.filter((a) => a.isActive || a.id === accountId);
    let l = null;
    // 只有确实属于本公司的科目才去查；否则 getGeneralLedger 抛
    // 'Account not found'，整页 500。
    if (accountId && allAccts.some((a) => a.id === accountId)) {
      l = await getGeneralLedger(tx, context.organizationId, accountId, resolvedFrom, to);
    }
    return { accounts: options, ledger: l, from: resolvedFrom };
  });

  return (
    <>
      <div className="page-header">
        <h1>{t.generalLedger.title}</h1>
      </div>
      <GeneralLedgerView
        orgSlug={orgSlug}
        locale={locale}
        baseCurrency={context.baseCurrency}
        t={t}
        accounts={accounts.map((a) => ({
          id: a.id,
          code: a.code,
          nameEn: a.nameEn,
          nameZh: a.nameZh,
          type: a.type,
        }))}
        ledger={ledger}
        defaultFrom={from}
        defaultTo={to}
        defaultAccountId={accountId ?? ''}
      />
    </>
  );
}
