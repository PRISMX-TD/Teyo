'use client';

import { useState, useCallback, useEffect } from 'react';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (y: number, m: number) => {
      setLoading(true);
      setError(null);
      try {
        const data = await loadData(y, m);
        setRows(data);
      } catch {
        setError(t.errors.unexpected);
      } finally {
        setLoading(false);
      }
    },
    [loadData, t],
  );

  // 进页面就把本月载入。原来要先点一次「应用」才有数据，在那之前表格位置
  // 显示的是「这个期间没有预算」——一句对用户而言是错的话。
  // loadData 是服务端传下来的 Server Action 引用，只在挂载时取一次。
  useEffect(() => {
    void fetchData(initialYear, initialMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFetch = () => {
    fetchData(year, month);
  };

  const handleSave = async (row: BudgetRow) => {
    const accountId = row.accountId;
    const amount = editing[accountId] ?? '0';
    setSaving((prev) => ({ ...prev, [accountId]: true }));
    setError(null);
    try {
      await updateBudgetAction(orgSlug, { accountId, year, month, amount });
      setEditing((prev) => {
        const next = { ...prev };
        delete next[accountId];
        return next;
      });
      await fetchData(year, month);
    } catch {
      // 原来没有 catch：金额填错（「abc」、空串）时 Server Action 抛错，
      // 界面上什么都不发生，用户只能猜是不是没点上。
      setError(t.errors.validation);
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

      {error ? <p role="alert" className="form-error">{error}</p> : null}

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
              // variance = 预算 − 实际。费用少花是好事（正数），收入少收是坏事
              // （也是正数）——上色要按科目性质翻过来，否则没完成的收入目标
              // 会被标成绿色。
              const creditNatured =
                row.accountType === 'revenue' ||
                row.accountType === 'liability' ||
                row.accountType === 'equity';
              const favourable = creditNatured ? -varianceBig : varianceBig;

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
                  <td className={`numeric mono ${favourable > 0n ? 'positive' : favourable < 0n ? 'negative' : ''}`}>
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
