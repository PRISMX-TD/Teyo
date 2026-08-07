import { GeneralLedgerView } from '@/components/reports/general-ledger-view';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
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

  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = `${new Date().getFullYear()}-01-01`;
  const from = sp.from ?? defaultFrom;
  const to = sp.to ?? today;
  const accountId = sp.account;

  const { accounts, ledger } = await withTransaction(context.userId, async (tx) => {
    const allAccts = await listAllAccounts(tx, context.organizationId);
    const active = allAccts.filter((a) => a.isActive);
    let l = null;
    if (accountId) {
      l = await getGeneralLedger(tx, context.organizationId, accountId, from, to);
    }
    return { accounts: active, ledger: l };
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
