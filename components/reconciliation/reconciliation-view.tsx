'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';

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
    new Date().toISOString().slice(0, 10),
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

  const statementBalanceMinor = (() => {
    try {
      if (!statementBalance) return 0n;
      const cleaned = statementBalance.replace(/,/g, '');
      const parsed = parseFloat(cleaned);
      if (isNaN(parsed)) return 0n;
      return BigInt(Math.round(parsed * 100));
    } catch {
      return 0n;
    }
  })();

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
    .reduce((sum, [, val]) => {
      try {
        const cleaned = val.replace(/,/g, '');
        const parsed = parseFloat(cleaned);
        if (isNaN(parsed)) return sum;
        return sum + BigInt(Math.round(parsed * 100));
      } catch {
        return sum;
      }
    }, 0n);

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
