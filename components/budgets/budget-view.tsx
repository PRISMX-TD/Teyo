'use client';

import { useState, useCallback } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';

type BudgetRow = {
  accountId: string;
  accountCode: string;
  accountNameEn: string | null;
  accountNameZh: string | null;
  accountType: string;
  isMoneyAccount: boolean;
  budgetMinor: string;
  actualMinor: string;
  varianceMinor: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  initialYear: number;
  initialMonth: number;
  updateBudgetAction: (
    orgSlug: string,
    input: { accountId: string; year: number; month: number; amount: string },
  ) => Promise<void>;
  loadData: (year: number, month: number) => Promise<BudgetRow[]>;
};

function toOption(row: { accountNameEn: string | null; accountNameZh: string | null }) {
  return { name_en: row.accountNameEn, name_zh: row.accountNameZh };
}

export function BudgetView({
  orgSlug,
  locale,
  baseCurrency,
  t,
  initialYear,
  initialMonth,
  updateBudgetAction,
  loadData,
}: Props) {
  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(
    async (y: number, m: number) => {
      setLoading(true);
      try {
        const data = await loadData(y, m);
        setRows(data);
      } finally {
        setLoading(false);
      }
    },
    [loadData],
  );

  const handleFetch = () => {
    fetchData(year, month);
  };

  const handleSave = async (row: BudgetRow) => {
    const accountId = row.accountId;
    const amount = editing[accountId] ?? '0';
    setSaving((prev) => ({ ...prev, [accountId]: true }));
    try {
      await updateBudgetAction(orgSlug, { accountId, year, month, amount });
      setEditing((prev) => {
        const next = { ...prev };
        delete next[accountId];
        return next;
      });
      await fetchData(year, month);
    } finally {
      setSaving((prev) => ({ ...prev, [accountId]: false }));
    }
  };

  const years = Array.from({ length: 5 }, (_, i) => initialYear - 2 + i);
  const months = Array.from({ length: 12 }, (_, i) => i + 1);

  return (
    <div className="budget-view">
      <div className="budget-toolbar">
        <label>
          {t.budgets.year}
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
        <label>
          {t.budgets.month}
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {months.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <button onClick={handleFetch} disabled={loading}>
          {loading ? t.common.loading : t.filters.apply}
        </button>
      </div>

      {rows.length === 0 && !loading ? (
        <p className="empty-state">{t.budgets.empty}</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr>
              <th>{t.budgets.account}</th>
              <th className="numeric">{t.budgets.budget}</th>
              <th className="numeric">{t.budgets.actual}</th>
              <th className="numeric">{t.budgets.variance}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const budgetBig = (() => { try { return BigInt(row.budgetMinor); } catch { return 0n; } })();
              const actualBig = (() => { try { return BigInt(row.actualMinor); } catch { return 0n; } })();
              const varianceBig = (() => { try { return BigInt(row.varianceMinor); } catch { return 0n; } })();
              const isEditing = row.accountId in editing;

              return (
                <tr key={row.accountId}>
                  <td>
                    {row.accountCode}{' '}
                    {localizedName(toOption(row), locale)}
                  </td>
                  <td className="numeric mono">
                    {isEditing ? (
                      <input
                        type="text"
                        className="budget-input"
                        value={editing[row.accountId]}
                        onChange={(e) =>
                          setEditing((prev) => ({
                            ...prev,
                            [row.accountId]: e.target.value,
                          }))
                        }
                      />
                    ) : (
                      <span
                        onClick={() =>
                          setEditing((prev) => ({
                            ...prev,
                            [row.accountId]: formatMoney(budgetBig, baseCurrency, locale).replace(/[^0-9.]/g, ''),
                          }))
                        }
                        style={{ cursor: 'pointer' }}
                      >
                        {formatMoney(budgetBig, baseCurrency, locale)}
                      </span>
                    )}
                  </td>
                  <td className="numeric mono">
                    {row.isMoneyAccount
                      ? formatMoney(actualBig, baseCurrency, locale)
                      : actualBig >= 0
                        ? formatMoney(actualBig, baseCurrency, locale)
                        : `(${formatMoney(-actualBig, baseCurrency, locale)})`}
                  </td>
                  <td className={`numeric mono ${varianceBig > 0n ? 'positive' : varianceBig < 0n ? 'negative' : ''}`}>
                    {formatMoney(varianceBig, baseCurrency, locale)}
                  </td>
                  <td>
                    {isEditing && (
                      <button
                        onClick={() => handleSave(row)}
                        disabled={saving[row.accountId]}
                      >
                        {saving[row.accountId] ? '...' : t.budgets.save}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
