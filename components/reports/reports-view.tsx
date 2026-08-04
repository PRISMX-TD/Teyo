'use client';

import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { TrialBalanceRow } from '@/server/repositories/reports';
import type { ProfitLossResult, BalanceSheetResult } from '@/server/repositories/reports';

type Tab = 'trial-balance' | 'profit-loss' | 'balance-sheet';

type Props = {
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  trialBalance: TrialBalanceRow[];
  profitLoss: ProfitLossResult;
  balanceSheet: BalanceSheetResult;
};

/** localizedName 需要 name_en/name_zh，将 camelCase 类型适配过去 */
function toOption(row: { nameEn: string | null; nameZh: string | null }) {
  return { name_en: row.nameEn, name_zh: row.nameZh };
}

export function ReportsView({ locale, baseCurrency, t, trialBalance, profitLoss, balanceSheet }: Props) {
  const [tab, setTab] = useState<Tab>('trial-balance');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'trial-balance', label: t.reports.trialBalance },
    { key: 'profit-loss', label: t.reports.profitLoss },
    { key: 'balance-sheet', label: t.reports.balanceSheet },
  ];

  return (
    <>
      <nav className="report-tabs">
        {tabs.map((tabItem) => (
          <button
            key={tabItem.key}
            className={tab === tabItem.key ? 'active' : ''}
            onClick={() => setTab(tabItem.key)}
          >
            {tabItem.label}
          </button>
        ))}
      </nav>

      {tab === 'trial-balance' ? (
        <TrialBalanceTable rows={trialBalance} locale={locale} baseCurrency={baseCurrency} t={t} />
      ) : tab === 'profit-loss' ? (
        <ProfitLossTable data={profitLoss} locale={locale} baseCurrency={baseCurrency} t={t} />
      ) : (
        <BalanceSheetTable data={balanceSheet} locale={locale} baseCurrency={baseCurrency} t={t} />
      )}
    </>
  );
}

function TrialBalanceTable({
  rows,
  locale,
  baseCurrency,
  t,
}: {
  rows: TrialBalanceRow[];
  locale: Locale;
  baseCurrency: string;
  t: Messages;
}) {
  if (rows.length === 0) return <p className="empty-state">{t.reports.empty}</p>;

  const totalDebit = rows.reduce((s, r) => s + r.debitMinor, 0n);
  const totalCredit = rows.reduce((s, r) => s + r.creditMinor, 0n);

  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>{t.reports.account}</th>
          <th className="numeric">{t.reports.debit}</th>
          <th className="numeric">{t.reports.credit}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.code}>
            <td>{localizedName(toOption(row), locale)}</td>
            <td className="numeric mono">
              {row.debitMinor > 0n ? formatMoney(row.debitMinor, baseCurrency, locale) : ''}
            </td>
            <td className="numeric mono">
              {row.creditMinor > 0n ? formatMoney(row.creditMinor, baseCurrency, locale) : ''}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th>{t.reports.total}</th>
          <th className="numeric mono">{formatMoney(totalDebit, baseCurrency, locale)}</th>
          <th className="numeric mono">{formatMoney(totalCredit, baseCurrency, locale)}</th>
        </tr>
      </tfoot>
    </table>
  );
}

function ProfitLossTable({
  data,
  locale,
  baseCurrency,
  t,
}: {
  data: ProfitLossResult;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
}) {
  const hasRevenue = data.revenueRows.length > 0;
  const hasExpense = data.expenseRows.length > 0;
  if (!hasRevenue && !hasExpense) return <p className="empty-state">{t.reports.empty}</p>;

  return (
    <table className="report-table">
      <thead>
        <tr>
          <th colSpan={2}>{t.reports.profitLoss}</th>
        </tr>
      </thead>
      <tbody>
        {data.revenueRows.length > 0 && (
          <>
            <tr className="section-header">
              <td colSpan={2}>{t.reports.revenue}</td>
            </tr>
            {data.revenueRows.map((row) => (
              <tr key={row.code}>
                <td>{localizedName(toOption(row), locale)}</td>
                <td className="numeric mono">{formatMoney(row.totalMinor, baseCurrency, locale)}</td>
              </tr>
            ))}
            <tr className="subtotal">
              <td>{t.reports.total} {t.reports.revenue}</td>
              <td className="numeric mono">{formatMoney(data.revenueTotal, baseCurrency, locale)}</td>
            </tr>
          </>
        )}

        {data.expenseRows.length > 0 && (
          <>
            <tr className="section-header">
              <td colSpan={2}>{t.reports.expense}</td>
            </tr>
            {data.expenseRows.map((row) => (
              <tr key={row.code}>
                <td>{localizedName(toOption(row), locale)}</td>
                <td className="numeric mono">({formatMoney(row.totalMinor, baseCurrency, locale)})</td>
              </tr>
            ))}
            <tr className="subtotal">
              <td>{t.reports.total} {t.reports.expense}</td>
              <td className="numeric mono">({formatMoney(data.expenseTotal, baseCurrency, locale)})</td>
            </tr>
          </>
        )}

        <tr className="total-row">
          <th>{t.reports.netIncome}</th>
          <th className="numeric mono">
            {data.netIncome >= 0
              ? formatMoney(data.netIncome, baseCurrency, locale)
              : `(${formatMoney(-data.netIncome, baseCurrency, locale)})`}
          </th>
        </tr>
      </tbody>
    </table>
  );
}

function BalanceSheetTable({
  data,
  locale,
  baseCurrency,
  t,
}: {
  data: BalanceSheetResult;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
}) {
  const hasData = data.assetRows.length > 0 || data.liabilityRows.length > 0 || data.equityRows.length > 0;
  if (!hasData) return <p className="empty-state">{t.reports.empty}</p>;

  return (
    <table className="report-table">
      <thead>
        <tr>
          <th colSpan={2}>{t.reports.balanceSheet}</th>
        </tr>
      </thead>
      <tbody>
        {data.assetRows.length > 0 && (
          <>
            <tr className="section-header">
              <td colSpan={2}>{t.reports.assets}</td>
            </tr>
            {data.assetRows.map((row) => (
              <tr key={row.code}>
                <td>{localizedName(toOption(row), locale)}</td>
                <td className="numeric mono">{formatMoney(row.totalMinor, baseCurrency, locale)}</td>
              </tr>
            ))}
            <tr className="subtotal">
              <th>{t.reports.totalAssets}</th>
              <th className="numeric mono">{formatMoney(data.assetTotal, baseCurrency, locale)}</th>
            </tr>
          </>
        )}

        {data.liabilityRows.length > 0 && (
          <>
            <tr className="section-header">
              <td colSpan={2}>{t.reports.liabilities}</td>
            </tr>
            {data.liabilityRows.map((row) => (
              <tr key={row.code}>
                <td>{localizedName(toOption(row), locale)}</td>
                <td className="numeric mono">{formatMoney(row.totalMinor, baseCurrency, locale)}</td>
              </tr>
            ))}
            <tr className="subtotal">
              <td>{t.reports.totalLiabilities}</td>
              <td className="numeric mono">{formatMoney(data.liabilityTotal, baseCurrency, locale)}</td>
            </tr>
          </>
        )}

        {data.equityRows.length > 0 && (
          <>
            <tr className="section-header">
              <td colSpan={2}>{t.reports.equity}</td>
            </tr>
            {data.equityRows.map((row) => (
              <tr key={row.code}>
                <td>{localizedName(toOption(row), locale)}</td>
                <td className="numeric mono">{formatMoney(row.totalMinor, baseCurrency, locale)}</td>
              </tr>
            ))}
            <tr className="subtotal">
              <td>{t.reports.totalEquity}</td>
              <td className="numeric mono">{formatMoney(data.equityTotal, baseCurrency, locale)}</td>
            </tr>
          </>
        )}

        <tr className="total-row">
          <th>{t.reports.liabilitiesAndEquity}</th>
          <th className="numeric mono">
            {formatMoney(data.liabilityTotal + data.equityTotal, baseCurrency, locale)}
          </th>
        </tr>
      </tbody>
    </table>
  );
}
