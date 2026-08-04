'use client';

import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { LedgerResult } from '@/server/repositories/reports';

type AccountOption = {
  id: string;
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  type: string;
};

function toOption(row: { nameEn: string | null; nameZh: string | null }) {
  return { name_en: row.nameEn, name_zh: row.nameZh };
}

export function GeneralLedgerView({
  orgSlug,
  locale,
  baseCurrency,
  t,
  accounts,
  ledger,
  defaultFrom,
  defaultTo,
  defaultAccountId,
}: {
  orgSlug: string;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  accounts: AccountOption[];
  ledger: LedgerResult | null;
  defaultFrom: string;
  defaultTo: string;
  defaultAccountId: string;
}) {
  const router = useRouter();

  const grouped = new Map<string, AccountOption[]>();
  for (const a of accounts) {
    const g = grouped.get(a.type) ?? [];
    g.push(a);
    grouped.set(a.type, g);
  }

  return (
    <div>
      <form
        className="gl-controls"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const params = new URLSearchParams();
          const acct = fd.get('account') as string;
          const f = fd.get('from') as string;
          const t = fd.get('to') as string;
          if (acct) params.set('account', acct);
          if (f) params.set('from', f);
          if (t) params.set('to', t);
          router.push(`/${orgSlug}/general-ledger?${params.toString()}`);
        }}
      >
        <select name="account" defaultValue={defaultAccountId}>
          <option value="">{t.generalLedger.selectAccount}</option>
          {[...grouped.entries()].map(([type, options]) => (
            <optgroup key={type} label={type}>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {localizedName(toOption(a), locale)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <input type="date" name="from" defaultValue={defaultFrom} />
        <input type="date" name="to" defaultValue={defaultTo} />
        <button type="submit">{t.filters.apply}</button>
      </form>

      {!ledger ? (
        <p className="empty-state">{t.generalLedger.empty}</p>
      ) : (
        <>
          <h2>
            {ledger.accountCode} — {localizedName(toOption({ nameEn: ledger.accountNameEn, nameZh: ledger.accountNameZh }), locale)}
          </h2>
          <p>
            {t.generalLedger.openingBalance}: {formatMoney(ledger.openingBalance, baseCurrency, locale)}
          </p>
          <table className="report-table">
            <thead>
              <tr>
                <th>{t.generalLedger.date}</th>
                <th>{t.generalLedger.description}</th>
                <th className="numeric">{t.generalLedger.debit}</th>
                <th className="numeric">{t.generalLedger.credit}</th>
                <th className="numeric">{t.generalLedger.balance}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.lines.map((line, i) => (
                <tr key={i}>
                  <td>{line.date}</td>
                  <td>{line.description || '\u2014'}</td>
                  <td className="numeric mono">
                    {line.debitMinor > 0n ? formatMoney(line.debitMinor, baseCurrency, locale) : ''}
                  </td>
                  <td className="numeric mono">
                    {line.creditMinor > 0n ? formatMoney(line.creditMinor, baseCurrency, locale) : ''}
                  </td>
                  <td className="numeric mono">{formatMoney(line.balanceMinor, baseCurrency, locale)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={4}>{t.generalLedger.closingBalance}</th>
                <th className="numeric mono">{formatMoney(ledger.closingBalance, baseCurrency, locale)}</th>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}
