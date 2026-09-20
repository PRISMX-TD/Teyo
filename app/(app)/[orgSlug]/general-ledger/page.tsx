import { GeneralLedgerView } from '@/components/reports/general-ledger-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission, todayInOrg } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getFiscalYearStartMonth, getUserLocale } from '@/server/repositories/organizations';
import { fiscalYearFor } from '@/server/services/year-end-close';
import { listAllAccounts } from '@/server/repositories/accounts';
import { getGeneralLedger } from '@/server/repositories/reports';

export default async function GeneralLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 按公司时区，不是服务端 UTC（见 server/auth/guard.ts 的 todayInOrg）。
  const today = todayInOrg(context);
  const to = sp.to ?? today;
  const accountId = sp.account;

  const { accounts, ledger, from } = await withTransaction(context.userId, async (tx) => {
    // 默认起点是**本财年**的第一天，不再是 `${year}-01-01`。总账最常被打开
    // 的一次是「看看 retained-earnings 这个科目到底是怎么来的」，而年结分录
    // 落在财年最后一天——按日历年取默认区间的话，7 月起的公司打开总账，
    // 默认区间正好把上一次年结排除在外，那个科目的余额没有任何一行解释得了。
    const startMonth = await getFiscalYearStartMonth(tx, context.organizationId);
    const defaultFrom = fiscalYearFor(today, startMonth).start;
    const resolvedFrom = sp.from ?? defaultFrom;

    const allAccts = await listAllAccounts(tx, context.organizationId);
    const active = allAccts.filter((a) => a.isActive);
    let l = null;
    if (accountId) {
      l = await getGeneralLedger(tx, context.organizationId, accountId, resolvedFrom, to);
    }
    return { accounts: active, ledger: l, from: resolvedFrom };
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
