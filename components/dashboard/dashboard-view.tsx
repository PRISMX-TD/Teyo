/**
 * 仪表盘的展示层。刻意**没有** 'use client'。
 *
 * 原来它标着 'use client'，但整个文件里没有一个 useState / useEffect /
 * 事件处理器 / 浏览器 API——只有 <Link> 和几段内联 SVG。那条指令的代价是
 * 实打实的：整棵子树（含 first-run-checklist、permissions 的 can()、
 * 以及 formatMoney 拉进来的 Intl 用法）会被打进客户端 bundle 并在浏览器
 * 里重新 hydrate 一遍，换来的交互能力是零。
 *
 * 另外它收的 props 里带 bigint（DashboardKpis 的各项金额）。作为服务端
 * 组件，这些 bigint 就地渲染成字符串，根本不需要跨 RSC 边界序列化。
 */
import React from 'react';
import Link from 'next/link';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName, interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type {
  DashboardKpis,
  MonthlyTrend,
  ExpenseByCategory,
  BankBalance,
} from '@/server/repositories/dashboard';
import { FirstRunChecklist, type ChecklistState } from '@/components/dashboard/first-run-checklist';
import type { Role } from '@/server/domain/permissions';

type Props = {
  kpis: DashboardKpis;
  trends: MonthlyTrend[];
  expenses: ExpenseByCategory[];
  balances: BankBalance[];
  locale: Locale;
  baseCurrency: string;
  orgSlug: string;
  i18n: Messages;
  checklist: ChecklistState;
  role: Role;
  /** Task 16：待确认队列里未作废、还没分类的条目数。0 时不渲染角标块。 */
  uncertainCount: number;
};

const MONTH_LABELS_EN = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTH_LABELS_ZH = [
  '1月', '2月', '3月', '4月', '5月', '6月',
  '7月', '8月', '9月', '10月', '11月', '12月',
];

export function DashboardView({ kpis, trends, expenses, balances, locale, baseCurrency, orgSlug, i18n, checklist, role, uncertainCount }: Props) {
  const monthLabels = locale === 'zh' ? MONTH_LABELS_ZH : MONTH_LABELS_EN;

  return (
    <div className="dashboard">
      <FirstRunChecklist orgSlug={orgSlug} state={checklist} locale={locale} t={i18n} role={role} />
      <UncertainBanner orgSlug={orgSlug} count={uncertainCount} i18n={i18n} />
      <DashboardQuestions kpis={kpis} locale={locale} baseCurrency={baseCurrency} orgSlug={orgSlug} i18n={i18n} />
      <div className="dashboard-grid">
        <MonthlyTrendsChart trends={trends} monthLabels={monthLabels} i18n={i18n} />
        <ExpenseBreakdown expenses={expenses} locale={locale} baseCurrency={baseCurrency} i18n={i18n} />
      </div>
      <BankBalancesSection balances={balances} locale={locale} baseCurrency={baseCurrency} i18n={i18n} />
      <RecentActivity kpis={kpis} locale={locale} baseCurrency={baseCurrency} i18n={i18n} />
    </div>
  );
}

/**
 * Task 16：不是脚手架、不会自动消失——只要队列里还有未分类的条目就一直显示，
 * 提醒用户「悬置」是可以处理完的，而不是记忆里悄悄积压的东西。
 * count 为 0 时不渲染：这不是一个常驻入口，只有真的有事要做才出现。
 */
function UncertainBanner({
  orgSlug,
  count,
  i18n,
}: {
  orgSlug: string;
  count: number;
  i18n: Messages;
}) {
  if (count <= 0) return null;

  return (
    <Link href={`/${orgSlug}/uncertain`} className="uncertain-banner">
      <span className="uncertain-banner-title">{i18n.uncertain.title}</span>
      <span className="badge">{interpolate(i18n.uncertain.badge, { count })}</span>
    </Link>
  );
}

function DashboardQuestions({
  kpis,
  locale,
  baseCurrency,
  orgSlug,
  i18n,
}: {
  kpis: DashboardKpis;
  locale: Locale;
  baseCurrency: string;
  orgSlug: string;
  i18n: Messages;
}) {
  const isLoss = kpis.netIncome < 0n;

  const questions: { key: string; question: string; hint: string; value: bigint; href: string; className: string }[] = [
    {
      key: 'q1',
      question: i18n.overview.q1,
      hint: i18n.overview.q1Hint,
      value: kpis.netIncome,
      href: `/${orgSlug}/reports`,
      className: isLoss ? 'money-out' : '',
    },
    {
      key: 'q2',
      question: i18n.overview.q2,
      hint: i18n.overview.q2Hint,
      value: kpis.totalBankBalance,
      href: `/${orgSlug}/reports`,
      className: '',
    },
    {
      key: 'q3',
      question: i18n.overview.q3,
      hint: i18n.overview.q3Hint,
      value: kpis.unpaidInvoices,
      href: `/${orgSlug}/invoices`,
      className: 'money-in',
    },
    {
      key: 'q4',
      question: i18n.overview.q4,
      hint: i18n.overview.q4Hint,
      value: kpis.unpaidBills,
      href: `/${orgSlug}/bills`,
      className: 'money-out',
    },
  ];

  return (
    <section className="dashboard-questions">
      {questions.map((q) => (
        <Link key={q.key} href={q.href} className="question-card">
          <h3>{q.question}</h3>
          <p className={`question-value ${q.className}`}>{formatMoney(q.value, baseCurrency, locale)}</p>
          <p className="question-hint">{q.hint}</p>
        </Link>
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
              {/* --rule 是 DESIGN.md 里那套从未被实现的设计系统的变量名，
                  globals.css 里根本没有定义它。未定义的 var() 会让整条
                  声明在计算时失效，stroke 落回继承值 none——这几条 Y 轴
                  网格线从写下这一行的那天起就是看不见的。用实际存在的
                  边框色。 */}
              <line x1={padLeft} y1={y} x2={chartW - padRight} y2={y} style={{stroke:'var(--border-primary)',strokeWidth:1}} />
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
  baseCurrency,
  i18n,
}: {
  expenses: ExpenseByCategory[];
  locale: Locale;
  baseCurrency: string;
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
              <span className="expense-amount">{formatMoney(exp.total, baseCurrency, locale)}</span>
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
  baseCurrency,
  i18n,
}: {
  balances: BankBalance[];
  locale: Locale;
  baseCurrency: string;
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
              <span className="mono">{formatMoney(b.balance, baseCurrency, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentActivity({
  kpis,
  locale,
  baseCurrency,
  i18n,
}: {
  kpis: DashboardKpis;
  locale: Locale;
  baseCurrency: string;
  i18n: Messages;
}) {
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
                .replace('{unpaid}', formatMoney(kpis.unpaidInvoices, baseCurrency, locale))
                .replace('{overdue}', formatMoney(kpis.overdueInvoices, baseCurrency, locale))}
            </span>
          </div>
        )}
        {billUnpaid && (
          <div className="activity-item">
            <span className="activity-icon bill-icon" aria-hidden="true" />
            <span>
              {i18n.overview.unpaidBills}:{' '}
              {i18n.overview.unpaidCount
                .replace('{unpaid}', formatMoney(kpis.unpaidBills, baseCurrency, locale))
                .replace('{overdue}', formatMoney(kpis.overdueBills, baseCurrency, locale))}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
