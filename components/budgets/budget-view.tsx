'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { FocusEvent } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { PencilSimple } from '@/components/ui/icons';

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
  // 屏幕上这批行属于哪个期间。年、月下拉一改就变，行却要等点了「筛选」
  // 才重新载入；保存只能写到这里，不能写到下拉里刚选、还没载入的那个月。
  const [loaded, setLoaded] = useState({ year: initialYear, month: initialMonth });
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 连着点两次「应用」（或保存后的刷新与「应用」交错）时，先发的请求可能
  // 后回来，把旧期间的预算连同旧的 loaded 一起写回——之后的保存就落到了
  // 用户没在看的那个月。只认最后一次请求的结果。
  const latestFetch = useRef(0);

  const fetchData = useCallback(
    async (y: number, m: number) => {
      const seq = ++latestFetch.current;
      setLoading(true);
      setError(null);
      try {
        const data = await loadData(y, m);
        if (seq !== latestFetch.current) return;
        setRows(data);
        setLoaded({ year: y, month: m });
      } catch {
        if (seq === latestFetch.current) setError(t.errors.unexpected);
      } finally {
        if (seq === latestFetch.current) setLoading(false);
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

  /**
   * 正在保存的科目。不能只看 saving 这个 state：失焦保存和点「保存」
   * 在同一次点击里先后触发，第二个处理函数拿到的还是旧闭包里的 false，
   * 同一笔预算会被提交两次。
   */
  const inFlight = useRef(new Set<string>());

  const stopEditing = (accountId: string) => {
    setEditing((prev) => {
      const next = { ...prev };
      delete next[accountId];
      return next;
    });
  };

  const handleSave = async (row: BudgetRow) => {
    const accountId = row.accountId;
    if (inFlight.current.has(accountId)) return;
    const amount = editing[accountId] ?? '0';
    inFlight.current.add(accountId);
    setSaving((prev) => ({ ...prev, [accountId]: true }));
    setError(null);
    try {
      await updateBudgetAction(orgSlug, {
        accountId,
        year: loaded.year,
        month: loaded.month,
        amount,
      });
      stopEditing(accountId);
      await fetchData(loaded.year, loaded.month);
    } catch {
      // 原来没有 catch：金额填错（「abc」、空串）时 Server Action 抛错，
      // 界面上什么都不发生，用户只能猜是不是没点上。
      setError(t.errors.validation);
    } finally {
      inFlight.current.delete(accountId);
      setSaving((prev) => ({ ...prev, [accountId]: false }));
    }
  };

  // 按了 Esc 的那一行：输入框随即卸载，有的浏览器会在卸载时补发一次
  // blur——那一次不能被当成「填完了」去保存。
  const cancelled = useRef<string | null>(null);

  const startEditing = (accountId: string, initial: string) => {
    cancelled.current = null;
    setEditing((prev) => ({ ...prev, [accountId]: initial }));
  };

  // 手机上没有 Tab 键，点到别处就是「填完了」：改过就保存，没改就收起。
  // 焦点正落到本行的「保存」上时什么也不做，交给它的 click。
  const handleBlur = (event: FocusEvent<HTMLInputElement>, row: BudgetRow, original: string) => {
    if (cancelled.current === row.accountId) {
      cancelled.current = null;
      return;
    }
    const next = event.relatedTarget;
    if (next instanceof HTMLElement && next.dataset.saveFor === row.accountId) return;
    if ((editing[row.accountId] ?? '').trim() === original) {
      stopEditing(row.accountId);
      return;
    }
    void handleSave(row);
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

      {loading && rows.length === 0 ? (
        // 首次载入：原来这里是一条只有表头的空表，看上去像「什么都没有」。
        <p className="empty-state" aria-busy="true">{t.common.loading}</p>
      ) : rows.length === 0 ? (
        <p className="empty-state">{t.budgets.empty}</p>
      ) : (
        <div className="table-scroll">
          <table className="report-table budget-table">
            <thead>
              <tr>
                <th>{t.budgets.account}</th>
                <th className="numeric">{t.budgets.budget}</th>
                <th className="numeric">{t.budgets.actual}</th>
                <th className="numeric">{t.budgets.variance}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const budgetBig = (() => { try { return BigInt(row.budgetMinor); } catch { return 0n; } })();
                const actualBig = (() => { try { return BigInt(row.actualMinor); } catch { return 0n; } })();
                const varianceBig = (() => { try { return BigInt(row.varianceMinor); } catch { return 0n; } })();
                const isEditing = row.accountId in editing;
                const accountName = localizedName(toOption(row), locale);
                const editLabel = interpolate(t.budgets.editFor, { account: accountName });
                const original = formatMoney(budgetBig, baseCurrency, locale).replace(/[^0-9.]/g, '');
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
                    {/* 名称在前，科目代码退成下面一行小字（手机上不显示，和试算
                        平衡表一致）：代码在前时「maybank-current-account 马来亚
                        银行往来账户」在钉住的窄列里折成四五行。 */}
                    <td className="budget-account">
                      {accountName}
                      {row.accountCode ? (
                        <span className="budget-account-code">{row.accountCode}</span>
                      ) : null}
                    </td>
                    <td className="numeric mono">
                      {/* 「保存」和输入框在同一格：原来它单独占第五列，手机上
                          落在横向滑动的可视区以外，改完金额找不到按钮。 */}
                      {isEditing ? (
                        <div className="budget-edit">
                          <input
                            type="text"
                            inputMode="decimal"
                            enterKeyHint="done"
                            autoComplete="off"
                            autoFocus
                            className="budget-input"
                            aria-label={editLabel}
                            value={editing[row.accountId]}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) =>
                              setEditing((prev) => ({
                                ...prev,
                                [row.accountId]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                cancelled.current = row.accountId;
                                stopEditing(row.accountId);
                              }
                            }}
                            onBlur={(e) => handleBlur(e, row, original)}
                          />
                          <button
                            type="button"
                            className="btn-small"
                            data-save-for={row.accountId}
                            onClick={() => handleSave(row)}
                            disabled={saving[row.accountId]}
                            aria-busy={saving[row.accountId] || undefined}
                          >
                            {saving[row.accountId] ? '…' : t.budgets.save}
                          </button>
                        </div>
                      ) : (
                        // 原来是一个带 onClick 的 <span>：触屏上看不出能点，键盘
                        // 也够不着。现在是一个长得像输入框的按钮。
                        <button
                          type="button"
                          className="budget-amount"
                          onClick={() => startEditing(row.accountId, original)}
                        >
                          <span className="visually-hidden">{editLabel}: </span>
                          {formatMoney(budgetBig, baseCurrency, locale)}
                          <PencilSimple size={14} aria-hidden="true" />
                        </button>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
