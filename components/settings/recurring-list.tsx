'use client';

import { useState, useCallback } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';

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

type Props = {
  orgSlug: string;
  locale: Locale;
  t: Messages;
  entries: RecurringEntry[];
  moneyAccounts: MoneyAccountOption[];
  allAccounts: AccountOption[];
  categories: CategoryOption[];
  createAction: (orgSlug: string, input: Record<string, unknown>) => Promise<{ id: string }>;
  editAction: (orgSlug: string, id: string, fields: Record<string, unknown>) => Promise<void>;
  toggleAction: (orgSlug: string, id: string, active: boolean) => Promise<void>;
  generateAction: (orgSlug: string) => Promise<{ generated: number }>;
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
    kind: 'expense' as string,
    description: '',
    amount: '',
    currency: moneyAccounts[0]?.id ? '' : 'USD',
    debitAccountId: '',
    creditAccountId: '',
    categoryId: '',
    frequency: 'monthly' as string,
    interval: 1,
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);

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
    const dueCount = entries.filter(
      (e) => e.isActive && e.nextDueDate <= new Date().toISOString().slice(0, 10),
    ).length;
    if (dueCount === 0) return;
    if (!window.confirm(t.recurring.generateConfirm.replace('{n}', String(dueCount)))) return;

    setGenerating(true);
    try {
      await generateAction(orgSlug);
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
            entries.filter(
              (e) => e.isActive && e.nextDueDate <= new Date().toISOString().slice(0, 10),
            ).length === 0
          }
        >
          {generating ? t.common.loading : 'Run due now'}
        </button>
      </div>

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
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
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
              onChange={(e) => setForm((f) => ({ ...f, frequency: e.target.value }))}
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
