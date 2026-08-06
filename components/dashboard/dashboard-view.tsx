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

type NamePair = { nameEn: string | null; nameZh: string | null };

function toNamePair(row: NamePair): { name_en: string | null; name_zh: string | null } {
  return { name_en: row.nameEn, name_zh: row.nameZh };
}

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
  return (
    <div className="dashboard">
      <KpiCards kpis={kpis} i18n={i18n} />
      <MonthlyTrendsChart trends={trends} locale={locale} i18n={i18n} />
      <ExpenseBreakdown expenses={expenses} locale={locale} i18n={i18n} />
      <BankBalancesSection balances={balances} locale={locale} i18n={i18n} />
      <RecentActivity kpis={kpis} i18n={i18n} />
    </div>
  );
}

function KpiCards({ kpis, i18n }: { kpis: DashboardKpis; i18n: Messages }) {
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
  locale,
  i18n,
}: {
  trends: MonthlyTrend[];
  locale: Locale;
  i18n: Messages;
}) {
  if (trends.length === 0) return null;

  const chartW = 760;
  const chartH = 220;
  const padLeft = 60;
  const padBottom = 28;
  const padTop = 12;
  const padRight = 16;
  const plotW = chartW - padLeft - padRight;
  const plotH = chartH - padTop - padBottom;

  const maxVal = Math.max(
    1,
    ...trends.map((t) => Math.max(Number(t.income), Number(t.expense))),
  );

  const yTicks = 5;
  const monthLabels = locale === 'zh' ? MONTH_LABELS_ZH : MONTH_LABELS_EN;
  const groupW = plotW / trends.length;
  const barW = Math.max(4, Math.floor(groupW * 0.3));
  const gap = Math.max(1, Math.floor(groupW * 0.05));

  return (
    <section className="dashboard-section">
      <h3>Monthly Trends</h3>
      <svg
        viewBox={`0 0 ${chartW} ${chartH}`}
        className="chart-svg"
        role="img"
        aria-label="Monthly Trends"
      >
        {/* Y-axis grid lines and labels */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const val = (maxVal / yTicks) * i;
          const y = padTop + plotH - (val / maxVal) * plotH;
          const label = i === 0 ? '0' : (Number(val) / 100).toFixed(0) + 'k';
          return (
            <g key={i}>
              <line
                x1={padLeft}
                y1={y}
                x2={chartW - padRight}
                y2={y}
                stroke="#e5e7eb"
                strokeWidth="1"
              />
              <text x={padLeft - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#6b7280">
                {label}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {trends.map((t, idx) => {
          const groupX = padLeft + idx * groupW;
          const incomeH = maxVal > 0 ? (Number(t.income) / maxVal) * plotH : 0;
          const expenseH = maxVal > 0 ? (Number(t.expense) / maxVal) * plotH : 0;

          return (
            <g key={t.month}>
              {/* Income bar (green) */}
              <rect
                x={groupX + groupW / 2 - barW - gap / 2}
                y={padTop + plotH - incomeH}
                width={barW}
                height={incomeH || 1}
                fill="#22c55e"
                rx="2"
              />
              {/* Expense bar (red) */}
              <rect
                x={groupX + groupW / 2 + gap / 2}
                y={padTop + plotH - expenseH}
                width={barW}
                height={expenseH || 1}
                fill="#ef4444"
                rx="2"
              />
              {/* Month label */}
              <text
                x={groupX + groupW / 2}
                y={chartH - 6}
                textAnchor="middle"
                fontSize="10"
                fill="#6b7280"
              >
                {monthLabels[Number(t.month.slice(5, 7)) - 1]}
              </text>
            </g>
          );
        })}

        {/* Legend */}
        <rect x={chartW - 180} y={padTop - 4} width="12" height="12" fill="#22c55e" rx="2" />
        <text x={chartW - 164} y={padTop + 6} fontSize="11" fill="#374151">
          {i18n.transaction.income}
        </text>
        <rect x={chartW - 100} y={padTop - 4} width="12" height="12" fill="#ef4444" rx="2" />
        <text x={chartW - 84} y={padTop + 6} fontSize="11" fill="#374151">
          {i18n.transaction.expense}
        </text>
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
  const maxVal = Math.max(
    1,
    ...expenses.map((e) => Number(e.total)),
  );

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
                {localizedName(
                  { name_en: exp.categoryNameEn, name_zh: exp.categoryNameZh },
                  locale,
                )}
              </span>
              <div className="expense-bar-track">
                <div className="expense-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="expense-amount mono">{fmtMinor(exp.total)}</span>
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
  const invoiceOverdue = kpis.overdueInvoices > 0n;
  const billOverdue = kpis.overdueBills > 0n;

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
