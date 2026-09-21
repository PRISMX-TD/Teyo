'use client';

import React, { useCallback, useMemo, useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName, interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { TrialBalanceRow } from '@/server/repositories/reports';
import type { ProfitLossResult, BalanceSheetResult, CashFlowResult } from '@/server/repositories/reports';
import type { ArAgingRow, ApAgingRow, CustomerStatement } from '@/server/repositories/aging';
import type { ContactRow } from '@/server/repositories/contacts';
import {
  checkBalanceSheet,
  checkCashFlow,
  checkTrialBalance,
  type BalanceCheck,
} from '@/server/domain/report-invariants';

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
  /**
   * 损益表与现金流量表实际使用的期间（财年起始日 .. 今天）。
   *
   * 由服务端按 organizations.fiscal_year_start_month 算好传进来，客户端
   * 不再自己 startOfLocalYear()——那是日历年，而这个产品的财年可以从任何
   * 一个月开始。两边各算各的话，屏幕上会出现「标题说 1 月起、数字是
   * 7 月起」这种没人看得出来的错位。
   */
  period: { from: string; to: string };
};

function toOption(row: { nameEn: string | null; nameZh: string | null }) {
  return { name_en: row.nameEn, name_zh: row.nameZh };
}

function BalanceCheckRow({
  check,
  colSpan,
  locale,
  baseCurrency,
  t,
}: {
  check: BalanceCheck;
  colSpan: number;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
}) {
  return (
    <tr>
      <th>{t.reports.balanceCheck}</th>
      <th className="numeric" colSpan={colSpan}>
        {check.balanced
          ? t.reports.balanced
          : interpolate(t.reports.outOfBalanceBy, {
              amount: formatMoney(check.differenceMinor, baseCurrency, locale),
            })}
      </th>
    </tr>
  );
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
  period,
}: Props) {
  const [tab, setTab] = useState<Tab>('trial-balance');

  // memo 掉：下面 handleTabKeyDown 的 useCallback 依赖它，而一个每次渲染
  // 都重建的数组会让那个 useCallback 每次都重建——包了等于没包。
  const tabs: { key: Tab; label: string }[] = useMemo(() => [
    { key: 'trial-balance', label: t.reports.trialBalance },
    { key: 'profit-loss', label: t.reports.profitLoss },
    { key: 'balance-sheet', label: t.reports.balanceSheet },
    { key: 'cash-flow', label: t.reports.cashFlow },
    { key: 'ar-aging', label: t.arAging.title },
    { key: 'ap-aging', label: t.apAging.title },
    { key: 'customer-statement', label: t.customerStatement.title },
    { key: 'vendor-statement', label: t.vendorStatement.title },
  ], [t]);

  /**
   * 方向键在标签之间移动（WAI-ARIA tabs 模式）。
   *
   * 改成 role="tablist" 之后这一步是必须的，不是加分项：tablist 里只有
   * 选中的那个标签留在 Tab 序列里（tabIndex -1/0，见下面），键盘用户没有
   * 方向键就再也到不了另外七个报表。原来那版是 <nav> 包一排裸 <button>，
   * Tab 能逐个走过去，但读屏念出来是「八个用途不明的按钮」，既不知道它们
   * 是一组，也不知道当前正在看哪一个。
   */
  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      const lastIndex = tabs.length - 1;
      let nextIndex: number | null = null;

      if (event.key === 'ArrowRight') nextIndex = index === lastIndex ? 0 : index + 1;
      else if (event.key === 'ArrowLeft') nextIndex = index === 0 ? lastIndex : index - 1;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = lastIndex;
      if (nextIndex === null) return;

      event.preventDefault();
      setTab(tabs[nextIndex].key);
      // 这个模式下选中即显示，焦点必须跟着走，否则读屏读到的还是旧标签。
      const container = event.currentTarget.parentElement;
      container?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
    },
    [tabs],
  );

  return (
    <>
      <div className="report-tabs" role="tablist" aria-label={t.reports.tabsLabel}>
        {tabs.map((tabItem, index) => {
          const selected = tab === tabItem.key;
          return (
            <button
              key={tabItem.key}
              type="button"
              role="tab"
              id={`report-tab-${tabItem.key}`}
              aria-selected={selected}
              aria-controls="report-panel"
              // roving tabindex：整组标签在 Tab 序列里只占一站，
              // 组内靠方向键走。
              tabIndex={selected ? 0 : -1}
              className={selected ? 'active' : ''}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              onClick={() => setTab(tabItem.key)}
            >
              {tabItem.label}
            </button>
          );
        })}
      </div>

      <div id="report-panel" role="tabpanel" aria-labelledby={`report-tab-${tab}`} tabIndex={-1}>
      {tab === 'trial-balance' ? (
        <TrialBalanceTable rows={trialBalance} locale={locale} baseCurrency={baseCurrency} t={t} />
      ) : tab === 'profit-loss' ? (
        <ProfitLossTable data={profitLoss} locale={locale} baseCurrency={baseCurrency} t={t} period={period} />
      ) : tab === 'balance-sheet' ? (
        <BalanceSheetTable data={balanceSheet} locale={locale} baseCurrency={baseCurrency} t={t} />
      ) : tab === 'cash-flow' ? (
        <CashFlowTable data={cashFlow} locale={locale} baseCurrency={baseCurrency} t={t} period={period} />
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
          period={period}
        />
      ) : (
        <StatementTab
          contacts={contacts.filter((c) => c.type === 'vendor' || c.type === 'both')}
          orgSlug={orgSlug}
          locale={locale}
          baseCurrency={baseCurrency}
          t={t}
          type="vendor"
          period={period}
        />
      )}
      </div>
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
            <td>
              {localizedName(toOption(row), locale)}
              {row.isActive ? null : <span className="badge badge-voided">{t.reports.archived}</span>}
            </td>
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
        <BalanceCheckRow
          check={checkTrialBalance(rows)}
          colSpan={2}
          locale={locale}
          baseCurrency={baseCurrency}
          t={t}
        />
      </tfoot>
    </table>
  );
}

function ProfitLossTable({
  data,
  locale,
  baseCurrency,
  t,
  period,
}: {
  data: ProfitLossResult;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  period: { from: string; to: string };
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
        {/* 期间必须写在表上。财年可以从任何一个月开始，而「本年度」这三个
            字在 7 月起的公司里指的不是 1 月到今天——不写出来，用户没有任何
            办法判断眼前这张表算的是哪一段。 */}
        <tr>
          <th colSpan={2} className="report-period">
            {interpolate(t.reports.periodRange, { from: period.from, to: period.to })}
          </th>
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
  period,
}: {
  data: CashFlowResult;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  period: { from: string; to: string };
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
        {/* 与损益表同一个理由：这张表也是期间表，期间由财年决定。 */}
        <tr>
          <th colSpan={2} className="report-period">
            {interpolate(t.reports.periodRange, { from: period.from, to: period.to })}
          </th>
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
        {/* checkCashFlow now always reads balanced by construction (unclassified
            folds into netChange) — the row below is what surfaces the gap honestly,
            instead of the self-check silently reading "out of balance". */}
        {data.unclassified !== 0n && (
          <>
            <tr className="section-header">
              <td colSpan={2}>{t.reports.unclassified_cf}</td>
            </tr>
            <tr>
              <td>{t.reports.unclassifiedHint_cf}</td>
              <td className="numeric mono">{formatMoney(data.unclassified, baseCurrency, locale)}</td>
            </tr>
          </>
        )}
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
        <BalanceCheckRow
          check={checkCashFlow({
            openingCash: data.openingCash,
            netChange: data.netChange,
            closingCash: data.closingCash,
          })}
          colSpan={1}
          locale={locale}
          baseCurrency={baseCurrency}
          t={t}
        />
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

        <tr>
          <td>{t.reports.currentYearEarnings}</td>
          <td className="numeric mono">
            {formatMoney(data.currentYearEarnings, baseCurrency, locale)}
          </td>
        </tr>

        <tr className="total-row">
          <th>{t.reports.liabilitiesAndEquity}</th>
          <th className="numeric mono">
            {formatMoney(
              data.liabilityTotal + data.equityTotal + data.currentYearEarnings,
              baseCurrency,
              locale,
            )}
          </th>
        </tr>

        <BalanceCheckRow
          check={checkBalanceSheet({
            assetTotal: data.assetTotal,
            liabilityTotal: data.liabilityTotal,
            equityTotal: data.equityTotal,
            currentYearEarnings: data.currentYearEarnings,
          })}
          colSpan={1}
          locale={locale}
          baseCurrency={baseCurrency}
          t={t}
        />
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
            <td className="numeric mono">{formatMoney(row.current, baseCurrency, locale)}</td>
            <td className="numeric mono">{formatMoney(row.d31_60, baseCurrency, locale)}</td>
            <td className="numeric mono">{formatMoney(row.d61_90, baseCurrency, locale)}</td>
            <td className="numeric mono">{formatMoney(row.over90, baseCurrency, locale)}</td>
            <td className="numeric mono">{formatMoney(row.total, baseCurrency, locale)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th>{t.reports.total}</th>
          <th className="numeric mono">{formatMoney(totals.current, baseCurrency, locale)}</th>
          <th className="numeric mono">{formatMoney(totals.d31_60, baseCurrency, locale)}</th>
          <th className="numeric mono">{formatMoney(totals.d61_90, baseCurrency, locale)}</th>
          <th className="numeric mono">{formatMoney(totals.over90, baseCurrency, locale)}</th>
          <th className="numeric mono">{formatMoney(totals.total, baseCurrency, locale)}</th>
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
  period,
}: {
  contacts: ContactRow[];
  orgSlug: string;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  type: 'customer' | 'vendor';
  period: { from: string; to: string };
}) {
  const isCustomer = type === 'customer';
  const title = isCustomer ? t.customerStatement.title : t.vendorStatement.title;
  const selectLabel = isCustomer ? t.customerStatement.selectContact : t.vendorStatement.selectContact;

  const [contactId, setContactId] = useState('');
  // 默认区间跟着财年走，不再是 startOfLocalYear()（日历年 1 月 1 日）。
  // 同一页上损益表按财年算、对账单按日历年算的话，两张表对同一个客户给出
  // 的期间不同，而屏幕上没有任何东西说明为什么。
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
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
    } catch {
      // 原来的兜底文案是写死的英文。这里连 e.message 也一并换掉：
      // 上面抛的是 `HTTP 500`，把它直接摆给用户看，中文界面里会突然冒出
      // 一句英文技术缩写，而且他拿它什么也做不了。
      setError(t.reports.statementLoadFailed);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orgSlug, type, contactId, from, to, t]);

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
                <td className="numeric mono">{formatMoney(data.openingBalance, baseCurrency, locale)}</td>
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
                  <td className="numeric mono">{formatMoney(line.amount, baseCurrency, locale)}</td>
                  <td className="numeric mono">{formatMoney(line.balance, baseCurrency, locale)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={4}>{t.statement.closingBalance}</th>
              <th className="numeric mono">{formatMoney(data.closingBalance, baseCurrency, locale)}</th>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
