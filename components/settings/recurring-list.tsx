'use client';

import { useState, useCallback } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import type { UserEntryKind } from '@/server/domain/ledger';
import type { RecurringEditFields, RecurringRunReport } from '@/server/actions/recurring';
import type { RecurringTransactionRow } from '@/server/repositories/recurring';
import { todayLocalISO } from '@/lib/date';

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
  // 定期规则只能是用户能直接创建的四种之一——'closing' 只由年结产生。
  kind: UserEntryKind;
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
  /** 公司本位币。新建规则时的默认币种——原来这里硬写 'USD'。 */
  baseCurrency: string;
  entries: RecurringEntry[];
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

type FormState = {
  kind: UserEntryKind;
  description: string;
  amount: string;
  currency: string;
  debitAccountId: string;
  creditAccountId: string;
  categoryId: string;
  frequency: RecurringFrequency;
  interval: number;
  startDate: string;
  endDate: string;
};

function blankForm(baseCurrency: string): FormState {
  return {
    kind: 'expense',
    description: '',
    amount: '',
    currency: baseCurrency,
    debitAccountId: '',
    creditAccountId: '',
    categoryId: '',
    frequency: 'monthly',
    interval: 1,
    startDate: todayLocalISO(),
    endDate: '',
  };
}

export function RecurringList({
  orgSlug,
  locale,
  t,
  baseCurrency,
  entries,
  allAccounts,
  categories,
  createAction,
  editAction,
  toggleAction,
  generateAction,
}: Props) {
  const [showForm, setShowForm] = useState(false);
  /** null = 这张表单在新建；否则是正在编辑的那条规则的 id。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => blankForm(baseCurrency));
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  // 生成结果必须显示出来。生成可以部分成功之后，「什么都不说」就有歧义了：
  // 规则全被挡下的用户和规则全部入账的用户看到的是同一个空界面。
  const [runReport, setRunReport] = useState<RecurringRunReport | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const closeForm = useCallback(() => {
    setShowForm(false);
    setEditingId(null);
    setForm(blankForm(baseCurrency));
  }, [baseCurrency]);

  /**
   * 打开这张表单去改一条已有的规则。
   *
   * editAction 之前是「页面传进来、组件解构出来、然后一次都没用过」——也就是
   * 说编辑定期规则这件事在界面上根本没有入口，服务端那个 editRecurring
   * （连同它那道 `.strict()` 白名单）从来没有被任何人调用过。这里把它接上。
   */
  const startEdit = useCallback((entry: RecurringEntry) => {
    setEditingId(entry.id);
    setForm({
      // kind 不在 RecurringEditFields 里，改不了；带进表单只是为了让下面那些
      // 按 kind 过滤的下拉框（分类）显示得对。
      kind: entry.kind as UserEntryKind,
      description: entry.description ?? '',
      amount: entry.amount,
      currency: entry.currency,
      debitAccountId: entry.debitAccountId,
      creditAccountId: entry.creditAccountId,
      categoryId: entry.categoryId ?? '',
      frequency: entry.frequency as RecurringFrequency,
      interval: entry.interval,
      startDate: entry.startDate,
      endDate: entry.endDate ?? '',
    });
    setShowForm(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!form.amount || !form.debitAccountId || !form.creditAccountId) return;
    setSubmitting(true);
    try {
      if (editingId) {
        await editAction(orgSlug, editingId, {
          description: form.description,
          // amount 与 currency 必须成对传：服务端要靠币种决定按几位小数解析。
          amount: form.amount,
          currency: form.currency,
          debitAccountId: form.debitAccountId,
          creditAccountId: form.creditAccountId,
          // 清空下拉框传 null（「这条规则不再归任何分类」），而不是 undefined
          // （「这一次不动分类」）。两者在服务端是不同的意思。
          categoryId: form.categoryId || null,
          frequency: form.frequency,
          interval: form.interval,
          startDate: form.startDate,
          endDate: form.endDate || null,
        });
      } else {
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
      }
      closeForm();
    } finally {
      setSubmitting(false);
    }
  }, [form, editingId, orgSlug, createAction, editAction, closeForm]);

  const handleGenerate = useCallback(async () => {
    // 数的是到期的规则条数，不是将要生成的分录笔数——补记会让后者更大。
    // 文案已经改成明说自己数的是规则，并提醒逾期规则会一期一笔。
    const today = todayLocalISO();
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

  return (
    <div className="recurring-list">
      <div className="recurring-toolbar">
        <button onClick={() => (showForm ? closeForm() : setShowForm(true))}>
          {showForm ? t.common.cancel : t.recurring.newTitle}
        </button>
        <button
          onClick={handleGenerate}
          disabled={
            generating ||
            !entries.some((e) => isDue(e, todayLocalISO()))
          }
        >
          {generating ? t.common.loading : t.recurring.runDue}
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
            handleSubmit();
          }}
        >
          <h3>{editingId ? t.recurring.editTitle : t.recurring.newTitle}</h3>

          {/*
            编辑时类型锁住。类型决定了这条规则将来生成的是收入还是支出分录，
            而已经按旧类型生成过的那些分录不会跟着改。允许中途改类型，会得到
            一条前半年记支出、后半年记收入的规则，报表上没有任何地方说得清
            这件事。RecurringEditFields 里本来也没有 kind 这个字段。
          */}
          <label>
            {t.transaction.kind}
            <select
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as UserEntryKind }))}
              disabled={editingId !== null}
            >
              <option value="income">{t.transaction.income}</option>
              <option value="expense">{t.transaction.expense}</option>
              <option value="transfer">{t.transaction.transfer}</option>
            </select>
            {editingId ? <span className="hint">{t.recurring.kindLocked}</span> : null}
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
              <th>{t.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.kind}</td>
                <td>{entry.description}</td>
                <td className="numeric mono">
                  {(() => {
                    // 原来这里是 BigInt(Math.round(parseFloat(amount) * 100))。
                    // 两个毛病，和对账那一页当初一模一样：浮点，以及硬编码
                    // ×100——一条 1,000,000 日元的规则会显示成 10,000 日元，
                    // 因为 JPY 没有小数位（见 money.ts 的 ZERO_DECIMAL_CURRENCIES）。
                    try {
                      return formatMoney(
                        parseDecimalToMinor(entry.amount, currencyExponent(entry.currency)),
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
                <td>
                  <button type="button" onClick={() => startEdit(entry)}>
                    {t.common.edit}
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
