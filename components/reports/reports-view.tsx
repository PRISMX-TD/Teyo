'use client';

import React, { useState, useCallback } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { TrialBalanceRow } from '@/server/repositories/reports';
import type { ProfitLossResult, BalanceSheetResult, CashFlowResult } from '@/server/repositories/reports';
import type { ArAgingRow, ApAgingRow, CustomerStatement } from '@/server/repositories/aging';
import type { ContactRow } from '@/server/repositories/contacts';

type Tab = 'trial-balance' | 'profit-loss' | 'balance-sheet' | 'cash-flow' | 'ar-aging' | 'ap-aging' | 'customer-statement' | 'vendor-statement';

type Props = {
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  trialBalance: TrialBalanceRow[];
  profitLoss: ProfitLossResult;
  balanceSheet: BalanceSheetResult;
  cashFlow: CashFlowResult;
  arAging: ArAgingRow[];
  apAging: ApAgingRow[];
  contacts: ContactRow[];
  orgSlug: string;
};

function toOption(row: { nameEn: string | null; nameZh: string | null }) {
  return { name_en: row.nameEn, name_zh: row.nameZh };
}

function fmtMinor(amount: bigint): string {
  return (Number(amount) / 100).toFixed(2);
}

export function ReportsView({
  locale,
  baseCurrency,
  t,
  trialBalance,
  profitLoss,
  balanceSheet,
  cashFlow,
  arAging,
  apAging,
  contacts,
  orgSlug,
}: Props) {
  const [tab, setTab] = useState<Tab>('trial-balance');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'trial-balance', label: t.reports.trialBalance },
    { key: 'profit-loss', label: t.reports.profitLoss },
    { key: 'balance-sheet', label: t.reports.balanceSheet },
    { key: 'cash-flow', label: t.reports.cashFlow },
    { key: 'ar-aging', label: t.arAging.title },
    { key: 'ap-aging', label: t.apAging.title },
    { key: 'customer-statement', label: t.customerStatement.title },
    { key: 'vendor-statement', label: t.vendorStatement.title },
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
      ) : tab === 'balance-sheet' ? (
        <BalanceSheetTable data={balanceSheet} locale={locale} baseCurrency={baseCurrency} t={t} />
      ) : tab === 'cash-flow' ? (
        <CashFlowTable data={cashFlow} locale={locale} baseCurrency={baseCurrency} t={t} />
      ) : tab === 'ar-aging' ? (
        <AgingTable rows={arAging} locale={locale} baseCurrency={baseCurrency} t={t} type="ar" />
      ) : tab === 'ap-aging' ? (
        <AgingTable rows={apAging} locale={locale} baseCurrency={baseCurrency} t={t} type="ap" />
      ) : tab === 'customer-statement' ? (
        <StatementTab
          contacts={contacts.filter((c) => c.type === 'customer' || c.type === 'both')}
          orgSlug={orgSlug}
          locale={locale}
          baseCurrency={baseCurrency}
          t={t}
          type="customer"
        />
      ) : (
        <StatementTab
          contacts={contacts.filter((c) => c.type === 'vendor' || c.type === 'both')}
          orgSlug={orgSlug}
          locale={locale}
          baseCurrency={baseCurrency}
          t={t}
          type="vendor"
        />
      )}
    </>
  );
}

/* ── Existing tables unchanged ── */

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

function CashFlowTable({
  data,
  locale,
  baseCurrency,
  t,
}: {
  data: CashFlowResult;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
}) {
  const sectionLabels: Record<string, string> = {
    Operating: t.reports.operating,
    Investing: t.reports.investing,
    Financing: t.reports.financing,
  };

  const lineLabels: Record<string, string> = {
    netIncome: t.reports.netIncome_cf,
    depreciation: t.reports.depreciation_cf,
    amortization: t.reports.amortization_cf,
    arChange: t.reports.arChange,
    apChange: t.reports.apChange,
    invChange: t.reports.invChange,
    deferredRevChange: t.reports.deferredRevChange,
    prepaidChange: t.reports.prepaidChange,
    equipment: t.reports.equipment_cf,
    furniture: t.reports.furniture_cf,
    vehicles: t.reports.vehicles_cf,
    softwareIntangible: t.reports.softwareIntangible_cf,
    capital: t.reports.capital_cf,
    loans: t.reports.loans_cf,
    ownersDraw: t.reports.ownersDraw_cf,
  };

  return (
    <table className="report-table">
      <thead>
        <tr>
          <th colSpan={2}>{t.reports.cashFlow}</th>
        </tr>
      </thead>
      <tbody>
        {([data.operating, data.investing, data.financing] as const).map((section) => (
          <React.Fragment key={section.label}>
            <tr className="section-header">
              <td colSpan={2}>{sectionLabels[section.label] ?? section.label}</td>
            </tr>
            {section.rows.map((row, i) => (
              <tr key={i}>
                <td>{lineLabels[row.label] ?? row.label}</td>
                <td className="numeric mono">{formatMoney(row.amountMinor, baseCurrency, locale)}</td>
              </tr>
            ))}
          </React.Fragment>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th>{t.reports.netCashFlow}</th>
          <th className="numeric mono">{formatMoney(data.netChange, baseCurrency, locale)}</th>
        </tr>
        <tr>
          <td>{t.reports.openingCash}</td>
          <td className="numeric mono">{formatMoney(data.openingCash, baseCurrency, locale)}</td>
        </tr>
        <tr>
          <td>{t.reports.closingCash}</td>
          <td className="numeric mono">{formatMoney(data.closingCash, baseCurrency, locale)}</td>
        </tr>
      </tfoot>
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

/* ── AR/AP Aging table ── */

function AgingTable({
  rows,
  locale,
  baseCurrency,
  t,
  type,
}: {
  rows: ArAgingRow[] | ApAgingRow[];
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  type: 'ar' | 'ap';
}) {
  const aging = type === 'ar' ? t.arAging : t.apAging;

  if (rows.length === 0) return <p className="empty-state">{t.reports.empty}</p>;

  const totals = rows.reduce(
    (acc, r) => ({
      current: acc.current + r.current,
      d31_60: acc.d31_60 + r.d31_60,
      d61_90: acc.d61_90 + r.d61_90,
      over90: acc.over90 + r.over90,
      total: acc.total + r.total,
    }),
    { current: 0n, d31_60: 0n, d61_90: 0n, over90: 0n, total: 0n },
  );

  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>{type === 'ar' ? t.invoices.customer : t.bills.vendor}</th>
          <th className="numeric">{aging.current}</th>
          <th className="numeric">{aging.days60}</th>
          <th className="numeric">{aging.days90}</th>
          <th className="numeric">{aging.over90}</th>
          <th className="numeric">{aging.total}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.contactId}>
            <td>{row.contactName}</td>
            <td className="numeric mono">{fmtMinor(row.current)}</td>
            <td className="numeric mono">{fmtMinor(row.d31_60)}</td>
            <td className="numeric mono">{fmtMinor(row.d61_90)}</td>
            <td className="numeric mono">{fmtMinor(row.over90)}</td>
            <td className="numeric mono">{fmtMinor(row.total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th>{t.reports.total}</th>
          <th className="numeric mono">{fmtMinor(totals.current)}</th>
          <th className="numeric mono">{fmtMinor(totals.d31_60)}</th>
          <th className="numeric mono">{fmtMinor(totals.d61_90)}</th>
          <th className="numeric mono">{fmtMinor(totals.over90)}</th>
          <th className="numeric mono">{fmtMinor(totals.total)}</th>
        </tr>
      </tfoot>
    </table>
  );
}

/* ── Statement tab (Customer / Vendor) ── */

function StatementTab({
  contacts,
  orgSlug,
  locale,
  baseCurrency,
  t,
  type,
}: {
  contacts: ContactRow[];
  orgSlug: string;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  type: 'customer' | 'vendor';
}) {
  const isCustomer = type === 'customer';
  const title = isCustomer ? t.customerStatement.title : t.vendorStatement.title;
  const selectLabel = isCustomer ? t.customerStatement.selectContact : t.vendorStatement.selectContact;

  const [contactId, setContactId] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const [from, setFrom] = useState(yearStart);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<CustomerStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchStatement = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `/api/${orgSlug}/statement?type=${type}&contactId=${contactId}&from=${from}&to=${to}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load statement');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orgSlug, type, contactId, from, to]);

  return (
    <div className="statement-tab">
      <h3>{title}</h3>

      <div className="statement-controls">
        <label>
          {selectLabel}
          <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">{selectLabel}</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.reports.from}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t.reports.to}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button onClick={fetchStatement} disabled={!contactId || loading}>
          {loading ? t.common.loading : title}
        </button>
      </div>

      {error && <p className="error-message">{error}</p>}

      {data && (
        <table className="report-table">
          <thead>
            <tr>
              <th>{t.statement.date}</th>
              <th>{t.statement.description}</th>
              <th>{t.statement.reference}</th>
              <th className="numeric">{t.statement.amount}</th>
              <th className="numeric">{t.statement.balance}</th>
            </tr>
          </thead>
          <tbody>
            {data.openingBalance !== 0n && (
              <tr className="opening-balance">
                <td colSpan={3}>{t.statement.openingBalance}</td>
                <td className="numeric mono" />
                <td className="numeric mono">{fmtMinor(data.openingBalance)}</td>
              </tr>
            )}
            {data.lines.length === 0 && !loading ? (
              <tr>
                <td colSpan={5} className="empty-state">
                  {t.statement.noTransactions}
                </td>
              </tr>
            ) : (
              data.lines.map((line, i) => (
                <tr key={i}>
                  <td className="mono">{line.date}</td>
                  <td>{line.description}</td>
                  <td className="mono">{line.reference}</td>
                  <td className="numeric mono">{fmtMinor(line.amount)}</td>
                  <td className="numeric mono">{fmtMinor(line.balance)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={4}>{t.statement.closingBalance}</th>
              <th className="numeric mono">{fmtMinor(data.closingBalance)}</th>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
