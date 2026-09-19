'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { todayLocalISO } from '@/lib/date';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';

type MoneyAccountOption = {
  id: string;
  nameEn: string | null;
  nameZh: string | null;
};

type UnreconciledTxn = {
  id: string;
  occurredOn: string;
  description: string;
  kind: string;
  amountMinor: string;
  currency: string;
};

type PastReconciliation = {
  id: string;
  statementDate: string;
  statementBalanceMinor: string;
  reconciledAt: string | null;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  baseCurrency: string;
  t: Messages;
  moneyAccounts: MoneyAccountOption[];
  reconcileAction: (
    orgSlug: string,
    input: {
      moneyAccountId: string;
      statementDate: string;
      statementBalance: string;
      itemIds: string[];
      adjustments: Record<string, string>;
    },
  ) => Promise<{ id: string }>;
  loadData: (moneyAccountId: string) => Promise<{
    txns: UnreconciledTxn[];
    past: PastReconciliation[];
    bookBalance: string;
  }>;
};

function toOption(row: { nameEn: string | null; nameZh: string | null }) {
  return { name_en: row.nameEn, name_zh: row.nameZh };
}

export function ReconciliationView({
  orgSlug,
  locale,
  baseCurrency,
  t,
  moneyAccounts,
  reconcileAction,
  loadData,
}: Props) {
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [txns, setTxns] = useState<UnreconciledTxn[]>([]);
  const [pastReconciliations, setPastReconciliations] = useState<PastReconciliation[]>([]);
  const [bookBalance, setBookBalance] = useState<string>('0');
  const [statementDate, setStatementDate] = useState<string>(
    todayLocalISO(),
  );
  const [statementBalance, setStatementBalance] = useState<string>('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [adjustments, setAdjustments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(
    async (accountId: string) => {
      if (!accountId) return;
      setLoading(true);
      try {
        const data = await loadData(accountId);
        setTxns(data.txns);
        setPastReconciliations(data.past);
        setBookBalance(data.bookBalance);
        setChecked(new Set());
        setAdjustments({});
      } finally {
        setLoading(false);
      }
    },
    [loadData],
  );

  useEffect(() => {
    if (selectedAccount) {
      fetchData(selectedAccount);
    }
  }, [selectedAccount, fetchData]);

  const handleCheck = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleAdjustment = (id: string, value: string) => {
    setAdjustments((prev) => ({ ...prev, [id]: value }));
  };

  /**
   * 把用户输入的十进制金额转成最小货币单位。
   *
   * 原来这里是 `BigInt(Math.round(parseFloat(cleaned) * 100))`，两个毛病：
   *
   *   1. 浮点。0.1 + 0.2 那一类误差在对账这个场景里格外难看——用户输的
   *      对账单余额和账面余额只差几分时，差额那一栏会显示一个不存在的
   *      零头，而两边其实是平的。这个项目其余地方一律走 bigint 定点。
   *   2. 硬编码 ×100。零小数币种（JPY / KRW / VND，见 money.ts 的
   *      ZERO_DECIMAL_CURRENCIES）会被放大 100 倍：一家日元公司输入
   *      1,000,000 的对账单余额，差额那一栏会告诉他差了 9,900 万日元。
   *
   * 现在复用服务端的 parseDecimalToMinor + currencyExponent，和账面余额
   * （bookBalance，服务端本来就是按本位币的最小单位存的）在同一个刻度上。
   * 输入还没打完时解析会抛错，这时按 0 处理——差额本来就还没意义。
   */
  const exponent = (() => {
    try {
      return currencyExponent(baseCurrency);
    } catch {
      return 2;
    }
  })();

  const toMinor = useCallback(
    (value: string): bigint => {
      const cleaned = value.trim().replace(/,/g, '');
      if (!cleaned) return 0n;
      const negative = cleaned.startsWith('-');
      try {
        // parseDecimalToMinor 只收非负数；负号在这里单独摘出来再补回去，
        // 因为对账调整项确实可能是负的（银行手续费）。
        const magnitude = parseDecimalToMinor(negative ? cleaned.slice(1) : cleaned, exponent);
        return negative ? -magnitude : magnitude;
      } catch {
        return 0n;
      }
    },
    [exponent],
  );

  const statementBalanceMinor = toMinor(statementBalance);

  const bookBalanceBig = (() => {
    try {
      return BigInt(bookBalance);
    } catch {
      return 0n;
    }
  })();

  const clearedSum = txns
    .filter((t) => checked.has(t.id))
    .reduce((sum, t) => {
      try {
        return sum + BigInt(t.amountMinor);
      } catch {
        return sum;
      }
    }, 0n);

  const adjSum = Object.entries(adjustments)
    .filter(([id]) => checked.has(id))
    .reduce((sum, [, val]) => sum + toMinor(val), 0n);

  const difference = statementBalanceMinor - (bookBalanceBig + adjSum);

  const handleSubmit = async () => {
    if (!selectedAccount || !statementDate || !statementBalance) return;
    if (checked.size === 0 && !window.confirm(t.common.confirm + '?')) return;

    setSubmitting(true);
    try {
      await reconcileAction(orgSlug, {
        moneyAccountId: selectedAccount,
        statementDate,
        statementBalance,
        itemIds: Array.from(checked),
        adjustments,
      });
      setStatementBalance('');
      if (selectedAccount) {
        fetchData(selectedAccount);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="reconciliation-view">
      <div className="reconciliation-toolbar">
        <label>
          {t.reconciliation.selectAccount}
          <select
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
          >
            <option value="">--</option>
            {moneyAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {localizedName(toOption(a), locale)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading && <p>{t.common.loading}</p>}

      {!loading && selectedAccount && (
        <>
          <div className="reconciliation-summary">
            <label>
              {t.reconciliation.statementDate}
              <input
                type="date"
                value={statementDate}
                onChange={(e) => setStatementDate(e.target.value)}
              />
            </label>

            <label>
              {t.reconciliation.statementBalance}
              <input
                type="text"
                value={statementBalance}
                onChange={(e) => setStatementBalance(e.target.value)}
                placeholder="0.00"
              />
            </label>

            <div>
              <span>{t.reconciliation.bookBalance}: </span>
              <span className="mono">{formatMoney(bookBalanceBig, baseCurrency, locale)}</span>
            </div>

            <div>
              <span>{t.reconciliation.difference}: </span>
              <span className={`mono ${difference > 0n ? 'positive' : difference < 0n ? 'negative' : ''}`}>
                {formatMoney(difference, baseCurrency, locale)}
              </span>
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={submitting || checked.size === 0 || difference !== 0n}
          >
            {submitting ? t.common.loading : t.reconciliation.complete}
          </button>

          {txns.length === 0 ? (
            <p className="empty-state">{t.reconciliation.empty}</p>
          ) : (
            <table className="report-table">
              <thead>
                <tr>
                  <th>{t.reconciliation.cleared}</th>
                  <th>{t.transaction.date}</th>
                  <th>{t.transaction.description}</th>
                  <th>{t.transaction.kind}</th>
                  <th className="numeric">{t.transaction.amount}</th>
                  <th className="numeric">{t.reconciliation.adjustment}</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((txn) => (
                  <tr key={txn.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked.has(txn.id)}
                        onChange={() => handleCheck(txn.id)}
                      />
                    </td>
                    <td>{txn.occurredOn}</td>
                    <td>{txn.description}</td>
                    <td>{txn.kind}</td>
                    <td className="numeric mono">
                      {formatMoney(BigInt(txn.amountMinor), txn.currency, locale)}
                    </td>
                    <td>
                      <input
                        type="text"
                        className="adjustment-input"
                        value={adjustments[txn.id] ?? ''}
                        onChange={(e) => handleAdjustment(txn.id, e.target.value)}
                        placeholder="0.00"
                        disabled={!checked.has(txn.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {pastReconciliations.length > 0 && (
            <div className="past-reconciliations">
              <h3>{t.reconciliation.reconciledAt}</h3>
              <ul>
                {pastReconciliations.map((p) => (
                  <li key={p.id}>
                    {p.statementDate} —{' '}
                    {formatMoney(BigInt(p.statementBalanceMinor), baseCurrency, locale)}
                    {p.reconciledAt && (
                      <span> ({new Date(p.reconciledAt).toLocaleDateString()})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
