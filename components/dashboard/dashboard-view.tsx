'use client';

import React from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import type {
  DashboardKpis,
  MonthlyTrend,
  ExpenseByCategory,
  BankBalance,
} from '@/server/repositories/dashboard';

function fmtMinor(amount: bigint): string {
  return (Number(amount) / 100).toFixed(2);
}

type Props = {
  kpis: DashboardKpis;
  trends: MonthlyTrend[];
  expenses: ExpenseByCategory[];
  balances: BankBalance[];
  locale: Locale;
  i18n: Messages;
};

const MONTH_LABELS_EN = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTH_LABELS_ZH = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
];

export function DashboardView({ kpis, trends, expenses, balances, locale, i18n }: Props) {
  const monthLabels = locale === 'zh' ? MONTH_LABELS_ZH : MONTH_LABELS_EN;

  return (
    <div className="dashboard">
      <KpiHeroStrip kpis={kpis} i18n={i18n} />
      <div className="dashboard-grid">
        <MonthlyTrendsChart trends={trends} monthLabels={monthLabels} i18n={i18n} />
        <ExpenseBreakdown expenses={expenses} locale={locale} i18n={i18n} />
      </div>
      <BankBalancesSection balances={balances} locale={locale} i18n={i18n} />
      <RecentActivity kpis={kpis} i18n={i18n} />
    </div>
  );
}

function KpiHeroStrip({ kpis, i18n }: { kpis: DashboardKpis; i18n: Messages }) {
  const cards: { label: string; value: bigint; className: string }[] = [
    { label: i18n.overview.monthIncome, value: kpis.monthIncome, className: 'money-in' },
    { label: i18n.overview.monthExpense, value: kpis.monthExpense, className: 'money-out' },
    { label: i18n.overview.monthNet, value: kpis.netIncome, className: '' },
    { label: i18n.overview.accountBalances, value: kpis.totalBankBalance, className: '' },
    { label: i18n.overview.unpaidInvoices, value: kpis.unpaidInvoices, className: 'money-in' },
    { label: i18n.overview.unpaidBills, value: kpis.unpaidBills, className: 'money-out' },
  ];

  return (
    <section className="dashboard-kpis">
      {cards.map((card) => (
        <article key={card.label} className="kpi-card">
          <h3>{card.label}</h3>
          <p className={`kpi-value ${card.className}`}>{fmtMinor(card.value)}</p>
        </article>
      ))}
    </section>
  );
}

function MonthlyTrendsChart({
  trends,
  monthLabels,
  i18n,
}: {
  trends: MonthlyTrend[];
  monthLabels: string[];
  i18n: Messages;
}) {
  if (trends.length === 0) return null;

  const chartW = 760;
  const chartH = 240;
  const padLeft = 52;
  const padBottom = 30;
  const padTop = 14;
  const padRight = 16;
  const plotW = chartW - padLeft - padRight;
  const plotH = chartH - padTop - padBottom;

  const maxVal = Math.max(
    1,
    ...trends.map((t) => Math.max(Number(t.income), Number(t.expense))),
  );
  const yTicks = 4;
  const groupW = plotW / trends.length;
  const barW = Math.max(4, Math.floor(groupW * 0.32));
  const gap = Math.max(2, Math.floor(groupW * 0.06));

  return (
    <section className="dashboard-section">
      <h3>{i18n.overview.monthlyTrends}</h3>
      <svg
        viewBox={`0 0 ${chartW} ${chartH}`}
        className="chart-svg"
        role="img"
        aria-label={i18n.overview.monthlyTrends}
      >
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const val = (maxVal / yTicks) * i;
          const y = padTop + plotH - (val / maxVal) * plotH;
          return (
            <g key={i}>
              <line x1={padLeft} y1={y} x2={chartW - padRight} y2={y} style={{stroke:'var(--rule)',strokeWidth:1}} />
              <text x={padLeft - 6} y={y + 4} textAnchor="end" style={{fontSize:10,fill:'var(--text-tertiary)'}}>
                {i === 0 ? '0' : (Number(val) / 100).toFixed(0)}
              </text>
            </g>
          );
        })}
        {trends.map((t, idx) => {
          const groupX = padLeft + idx * groupW;
          const incomeH = maxVal > 0 ? (Number(t.income) / maxVal) * plotH : 0;
          const expenseH = maxVal > 0 ? (Number(t.expense) / maxVal) * plotH : 0;
          const barCenterY = padTop + plotH;
          return (
            <g key={t.month}>
              <rect x={groupX + groupW / 2 - barW - gap / 2} y={barCenterY - incomeH} width={barW} height={incomeH || 1} style={{fill:'var(--green)',rx:1}} />
              <rect x={groupX + groupW / 2 + gap / 2} y={barCenterY - expenseH} width={barW} height={expenseH || 1} style={{fill:'var(--accent)',rx:1}} />
              <text x={groupX + groupW / 2} y={chartH - 6} textAnchor="middle" style={{fontSize:10,fill:'var(--text-tertiary)'}}>
                {monthLabels[Number(t.month.slice(5, 7)) - 1]}
              </text>
            </g>
          );
        })}
        <rect x={chartW - 170} y={padTop} width="8" height="8" style={{fill:'var(--green)',rx:1}} />
        <text x={chartW - 156} y={padTop + 7} style={{fontSize:10,fill:'var(--text-secondary)'}}>{i18n.transaction.income}</text>
        <rect x={chartW - 95} y={padTop} width="8" height="8" style={{fill:'var(--accent)',rx:1}} />
        <text x={chartW - 81} y={padTop + 7} style={{fontSize:10,fill:'var(--text-secondary)'}}>{i18n.transaction.expense}</text>
      </svg>
    </section>
  );
}

function ExpenseBreakdown({
  expenses,
  locale,
  i18n,
}: {
  expenses: ExpenseByCategory[];
  locale: Locale;
  i18n: Messages;
}) {
  const maxVal = Math.max(1, ...expenses.map((e) => Number(e.total)));

  if (expenses.length === 0) {
    return (
      <section className="dashboard-section">
        <h3>{i18n.overview.spendingByCategory}</h3>
        <p className="empty-state">{i18n.overview.empty}</p>
      </section>
    );
  }

  return (
    <section className="dashboard-section">
      <h3>{i18n.overview.spendingByCategory}</h3>
      <div className="expense-bars">
        {expenses.map((exp) => {
          const pct = maxVal > 0 ? (Number(exp.total) / maxVal) * 100 : 0;
          return (
            <div key={(exp.categoryNameEn ?? '') + (exp.categoryNameZh ?? '')} className="expense-row">
              <span className="expense-label">
                {localizedName({ name_en: exp.categoryNameEn, name_zh: exp.categoryNameZh }, locale)}
              </span>
              <div className="expense-bar-track">
                <div className="expense-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="expense-amount">{fmtMinor(exp.total)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BankBalancesSection({
  balances,
  locale,
  i18n,
}: {
  balances: BankBalance[];
  locale: Locale;
  i18n: Messages;
}) {
  return (
    <section className="dashboard-section">
      <h3>{i18n.overview.accountBalances}</h3>
      {balances.length === 0 ? (
        <p className="empty-state">{i18n.overview.empty}</p>
      ) : (
        <ul className="balance-list">
          {balances.map((b) => (
            <li key={b.accountId}>
              <span>{localizedName({ name_en: b.accountNameEn, name_zh: b.accountNameZh }, locale)}</span>
              <span className="mono">{fmtMinor(b.balance)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentActivity({ kpis, i18n }: { kpis: DashboardKpis; i18n: Messages }) {
  const invoiceUnpaid = kpis.unpaidInvoices > 0n;
  const billUnpaid = kpis.unpaidBills > 0n;

  if (!invoiceUnpaid && !billUnpaid) {
    return (
      <section className="dashboard-section">
        <h3>{i18n.overview.recentTransactions}</h3>
        <p className="empty-state">{i18n.overview.empty}</p>
      </section>
    );
  }

  return (
    <section className="dashboard-section">
      <h3>{i18n.overview.recentTransactions}</h3>
      <div className="activity-list">
        {invoiceUnpaid && (
          <div className="activity-item">
            <span className="activity-icon invoice-icon" aria-hidden="true" />
            <span>
              {i18n.overview.unpaidInvoices}:{' '}
              {i18n.overview.unpaidCount
                .replace('{unpaid}', fmtMinor(kpis.unpaidInvoices))
                .replace('{overdue}', fmtMinor(kpis.overdueInvoices))}
            </span>
          </div>
        )}
        {billUnpaid && (
          <div className="activity-item">
            <span className="activity-icon bill-icon" aria-hidden="true" />
            <span>
              {i18n.overview.unpaidBills}:{' '}
              {i18n.overview.unpaidCount
                .replace('{unpaid}', fmtMinor(kpis.unpaidBills))
                .replace('{overdue}', fmtMinor(kpis.overdueBills))}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
