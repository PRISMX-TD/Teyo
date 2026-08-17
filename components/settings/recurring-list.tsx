'use client';

import { useState, useCallback } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { TransactionKind } from '@/server/domain/ledger';
import type { RecurringEditFields, RecurringRunReport } from '@/server/actions/recurring';
import type { RecurringTransactionRow } from '@/server/repositories/recurring';

type MoneyAccountOption = {
  id: string;
  nameEn: string | null;
  nameZh: string | null;
};

type AccountOption = {
  id: string;
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  type: string;
  isMoneyAccount: boolean;
};

type CategoryOption = {
  id: string;
  nameEn: string | null;
  nameZh: string | null;
  kind: string;
};

type RecurringEntry = {
  id: string;
  kind: string;
  description: string | null;
  amount: string;
  currency: string;
  debitAccountId: string;
  creditAccountId: string;
  categoryId: string | null;
  frequency: string;
  interval: number;
  startDate: string;
  endDate: string | null;
  nextDueDate: string;
  isActive: boolean;
};

type RecurringFrequency = RecurringTransactionRow['frequency'];

type CreatePayload = {
  kind: TransactionKind;
  description: string;
  amount: string;
  currency: string;
  debitAccountId: string;
  creditAccountId: string;
  categoryId?: string;
  frequency: RecurringFrequency;
  interval: number;
  startDate: string;
  endDate?: string;
};

// 直接用 action 导出的类型，而不是在这里再抄一份：amount 与 currency 必须
// 成对出现这条规则一旦两边各写各的就会漂移，而漂移的那一侧编译不报错。
type EditPayload = RecurringEditFields;

type Props = {
  orgSlug: string;
  locale: Locale;
  t: Messages;
  entries: RecurringEntry[];
  moneyAccounts: MoneyAccountOption[];
  allAccounts: AccountOption[];
  categories: CategoryOption[];
  createAction: (orgSlug: string, input: CreatePayload) => Promise<{ id: string }>;
  editAction: (orgSlug: string, id: string, fields: EditPayload) => Promise<void>;
  toggleAction: (orgSlug: string, id: string, active: boolean) => Promise<void>;
  generateAction: (orgSlug: string) => Promise<RecurringRunReport>;
};

function toOption(row: { nameEn: string | null; nameZh: string | null }) {
  return { name_en: row.nameEn, name_zh: row.nameZh };
}

const FREQUENCIES: { key: string; label: string }[] = [
  { key: 'daily', label: 'daily' },
  { key: 'weekly', label: 'weekly' },
  { key: 'monthly', label: 'monthly' },
  { key: 'quarterly', label: 'quarterly' },
  { key: 'yearly', label: 'yearly' },
];

/**
 * 与 getDueRecurring 的 where 子句同一套判断，三个条件缺一不可。
 *
 * 少了 endDate 那一条时，一条已经跑完的规则（游标停在结束日期之后，而且
 * 没有任何东西会去翻 is_active）会永远算作到期：按钮一直亮着，确认框说
 * 「1 条到期的规则」，点下去服务端一条都不选，结果又报「没有到期的分录」。
 */
function isDue(entry: RecurringEntry, today: string): boolean {
  return (
    entry.isActive &&
    entry.nextDueDate <= today &&
    (entry.endDate === null || entry.nextDueDate <= entry.endDate)
  );
}

export function RecurringList({
  orgSlug,
  locale,
  t,
  entries,
  moneyAccounts,
  allAccounts,
  categories,
  createAction,
  editAction,
  toggleAction,
  generateAction,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    kind: 'expense' as TransactionKind,
    description: '',
    amount: '',
    currency: moneyAccounts[0]?.id ? '' : 'USD',
    debitAccountId: '',
    creditAccountId: '',
    categoryId: '',
    frequency: 'monthly' as RecurringFrequency,
    interval: 1,
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  // 生成结果必须显示出来。生成可以部分成功之后，「什么都不说」就有歧义了：
  // 规则全被挡下的用户和规则全部入账的用户看到的是同一个空界面。
  const [runReport, setRunReport] = useState<RecurringRunReport | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!form.amount || !form.debitAccountId || !form.creditAccountId) return;
    setSubmitting(true);
    try {
      await createAction(orgSlug, {
        kind: form.kind,
        description: form.description,
        amount: form.amount,
        currency: form.currency,
        debitAccountId: form.debitAccountId,
        creditAccountId: form.creditAccountId,
        categoryId: form.categoryId || undefined,
        frequency: form.frequency,
        interval: form.interval,
        startDate: form.startDate,
        endDate: form.endDate || undefined,
      });
      setShowForm(false);
      setForm({
        kind: 'expense',
        description: '',
        amount: '',
        currency: 'USD',
        debitAccountId: '',
        creditAccountId: '',
        categoryId: '',
        frequency: 'monthly',
        interval: 1,
        startDate: new Date().toISOString().slice(0, 10),
        endDate: '',
      });
    } finally {
      setSubmitting(false);
    }
  }, [form, orgSlug, createAction]);

  const handleGenerate = useCallback(async () => {
    // 数的是到期的规则条数，不是将要生成的分录笔数——补记会让后者更大。
    // 文案已经改成明说自己数的是规则，并提醒逾期规则会一期一笔。
    const today = new Date().toISOString().slice(0, 10);
    const dueRules = entries.filter((e) => isDue(e, today)).length;
    if (dueRules === 0) return;
    if (!window.confirm(interpolate(t.recurring.generateConfirm, { n: dueRules }))) return;

    setGenerating(true);
    setRunReport(null);
    setRunError(null);
    try {
      setRunReport(await generateAction(orgSlug));
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [entries, orgSlug, generateAction, t]);

  const moneyAccount = moneyAccounts.find((a) => a.id === form.debitAccountId);
  const defaultCurrency = moneyAccount?.id ? 'USD' : form.currency;

  return (
    <div className="recurring-list">
      <div className="recurring-toolbar">
        <button onClick={() => setShowForm(!showForm)}>
          {showForm ? t.common.cancel : t.recurring.newTitle}
        </button>
        <button
          onClick={handleGenerate}
          disabled={
            generating ||
            !entries.some((e) => isDue(e, new Date().toISOString().slice(0, 10)))
          }
        >
          {generating ? t.common.loading : 'Run due now'}
        </button>
      </div>

      {runError ? (
        <p role="alert" className="form-error">
          {runError}
        </p>
      ) : null}

      {runReport ? (
        <div
          role="status"
          className={runReport.blocked.length > 0 ? 'form-error' : 'form-success'}
        >
          <p>
            {/*
              「没有到期的分录」和「没记上任何东西」是两回事。全部规则都被挡下时
              前者是假话——下面的 generateBlocked 才是真正的原因，标题不该跟它打架。
              只有真正无事可做时才说无事可做。
            */}
            {runReport.generated === 0 &&
            runReport.blocked.length === 0 &&
            runReport.deferred.length === 0
              ? t.recurring.generateNone
              : interpolate(t.recurring.generatedCount, { n: runReport.generated })}
          </p>

          {runReport.deferred.length > 0 ? (
            <>
              <p>{interpolate(t.recurring.generateDeferred, { n: runReport.deferred.length })}</p>
              <ul>
                {runReport.deferred.map((rule) => (
                  <li key={rule.id}>
                    {rule.description} &mdash;{' '}
                    {interpolate(t.recurring.generateResumeFrom, { date: rule.resumeFrom })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {runReport.blocked.length > 0 ? (
            <>
              <p>{interpolate(t.recurring.generateBlocked, { n: runReport.blocked.length })}</p>
              <ul>
                {runReport.blocked.map((rule) => (
                  <li key={rule.id}>
                    {/*
                      卡在哪一期要说出来：补记可能已经记好了前几期，停在第四期。
                      用户要去处理的是那一天（补一条那天的汇率之类），不是整条规则。
                      ISO 日期不需要翻译，所以这里不必再加一个文案键。
                    */}
                    {rule.description}
                    {rule.occurredOn ? ` (${rule.occurredOn})` : ''} &mdash; {rule.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {showForm && (
        <form
          className="recurring-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
        >
          <label>
            {t.transaction.kind}
            <select
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as TransactionKind }))}
            >
              <option value="income">{t.transaction.income}</option>
              <option value="expense">{t.transaction.expense}</option>
              <option value="transfer">{t.transaction.transfer}</option>
            </select>
          </label>

          <label>
            {t.transaction.amount}
            <input
              type="text"
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              placeholder="0.00"
              required
            />
          </label>

          <label>
            {t.transaction.currency}
            <input
              type="text"
              value={form.currency}
              onChange={(e) =>
                setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))
              }
              maxLength={3}
            />
          </label>

          <label>
            {t.journal.debitAccount}
            <select
              value={form.debitAccountId}
              onChange={(e) => setForm((f) => ({ ...f, debitAccountId: e.target.value }))}
              required
            >
              <option value="">{t.journal.selectAccount}</option>
              {allAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {localizedName(toOption(a), locale)}
                </option>
              ))}
            </select>
          </label>

          <label>
            {t.journal.creditAccount}
            <select
              value={form.creditAccountId}
              onChange={(e) => setForm((f) => ({ ...f, creditAccountId: e.target.value }))}
              required
            >
              <option value="">{t.journal.selectAccount}</option>
              {allAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {localizedName(toOption(a), locale)}
                </option>
              ))}
            </select>
          </label>

          <label>
            {t.transaction.category}
            <select
              value={form.categoryId}
              onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
            >
              <option value="">--</option>
              {categories
                .filter((c) =>
                  form.kind === 'income'
                    ? c.kind === 'income'
                    : form.kind === 'expense'
                      ? c.kind === 'expense'
                      : true,
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {localizedName(toOption(c), locale)}
                  </option>
                ))}
            </select>
          </label>

          <label>
            {t.transaction.description}
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </label>

          <label>
            {t.recurring.frequency}
            <select
              value={form.frequency}
              onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value as RecurringFrequency }))}
            >
              {FREQUENCIES.map((freq) => (
                <option key={freq.key} value={freq.key}>
                  {t.recurring[freq.label as keyof typeof t.recurring] ?? freq.key}
                </option>
              ))}
            </select>
          </label>

          <label>
            {t.recurring.interval}
            <input
              type="number"
              min={1}
              value={form.interval}
              onChange={(e) =>
                setForm((f) => ({ ...f, interval: Math.max(1, Number(e.target.value)) }))
              }
            />
          </label>

          <label>
            {t.recurring.startDate}
            <input
              type="date"
              value={form.startDate}
              onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
            />
          </label>

          <label>
            {t.recurring.endDate}
            <input
              type="date"
              value={form.endDate}
              onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
            />
          </label>

          <button type="submit" disabled={submitting}>
            {submitting ? t.common.loading : t.recurring.save}
          </button>
        </form>
      )}

      {entries.length === 0 ? (
        <p className="empty-state">{t.transaction.empty}</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr>
              <th>{t.transaction.kind}</th>
              <th>{t.transaction.description}</th>
              <th className="numeric">{t.transaction.amount}</th>
              <th>{t.recurring.frequency}</th>
              <th>{t.recurring.nextDue}</th>
              <th>{t.settings.active}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.kind}</td>
                <td>{entry.description}</td>
                <td className="numeric mono">
                  {(() => {
                    try {
                      return formatMoney(
                        BigInt(Math.round(parseFloat(entry.amount) * 100)),
                        entry.currency,
                        locale,
                      );
                    } catch {
                      return entry.amount;
                    }
                  })()}
                </td>
                <td>
                  {t.recurring[entry.frequency as keyof typeof t.recurring] ?? entry.frequency}
                  {entry.interval > 1 ? ` x${entry.interval}` : ''}
                </td>
                <td>{entry.nextDueDate}</td>
                <td>
                  <button
                    onClick={() => toggleAction(orgSlug, entry.id, !entry.isActive)}
                  >
                    {entry.isActive ? t.settings.active : t.settings.inactive}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
