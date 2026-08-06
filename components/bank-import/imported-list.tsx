'use client';

import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { ImportedTransactionRow } from '@/server/repositories/bank_import';
import { matchTransaction, ignoreImportedAction, resetImportedAction } from '@/server/actions/bank_import';

type MoneyAccountOption = {
  id: string;
  name_en: string | null;
  name_zh: string | null;
};

type SearchResult = {
  id: string;
  description: string;
  occurredOn: string;
  amountMinor: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  importedTxns: ImportedTransactionRow[];
  moneyAccounts: MoneyAccountOption[];
  baseCurrency: string;
  searchTxns: (query: string) => Promise<SearchResult[]>;
};

const STATUS_BADGE: Record<string, string> = {
  pending: 'badge',
  matched: 'badge badge-success',
  ignored: 'badge badge-voided',
};

export function ImportedList({
  orgSlug,
  locale,
  i18n,
  importedTxns,
  moneyAccounts,
  baseCurrency,
  searchTxns,
}: Props) {
  const [moneyAccountFilter, setMoneyAccountFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [matchDropdown, setMatchDropdown] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const filtered = importedTxns.filter((txn) => {
    if (moneyAccountFilter && txn.moneyAccountId !== moneyAccountFilter) return false;
    if (statusFilter && txn.status !== statusFilter) return false;
    return true;
  });

  const statusLabel: Record<string, string> = {
    pending: i18n.bankImport.pending,
    matched: i18n.bankImport.matched,
    ignored: i18n.bankImport.ignored,
  };

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const results = await searchTxns(query);
      setSearchResults(results);
    } finally {
      setSearching(false);
    }
  };

  const handleMatch = async (importedId: string, txnId: string) => {
    setActing(importedId);
    try {
      await matchTransaction(orgSlug, importedId, txnId);
      setMatchDropdown(null);
      setSearchQuery('');
      setSearchResults([]);
    } finally {
      setActing(null);
    }
  };

  const handleIgnore = async (id: string) => {
    setActing(id);
    try {
      await ignoreImportedAction(orgSlug, id);
    } finally {
      setActing(null);
    }
  };

  const handleReset = async (id: string) => {
    setActing(id);
    try {
      await resetImportedAction(orgSlug, id);
    } finally {
      setActing(null);
    }
  };

  if (importedTxns.length === 0) {
    return <p className="empty-state">{i18n.bankImport.imported}</p>;
  }

  return (
    <div className="imported-list">
      <h2>{i18n.bankImport.imported}</h2>

      <div className="imported-filters">
        <label>
          {i18n.bankImport.selectAccount}
          <select value={moneyAccountFilter} onChange={(e) => setMoneyAccountFilter(e.target.value)}>
            <option value="">--</option>
            {moneyAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {localizedName({ name_en: a.name_en, name_zh: a.name_zh }, locale)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">--</option>
            <option value="pending">{i18n.bankImport.pending}</option>
            <option value="matched">{i18n.bankImport.matched}</option>
            <option value="ignored">{i18n.bankImport.ignored}</option>
          </select>
        </label>
      </div>

      <table className="report-table">
        <thead>
          <tr>
            <th>{i18n.transaction.date}</th>
            <th>{i18n.transaction.description}</th>
            <th className="numeric">{i18n.transaction.amount}</th>
            <th>{i18n.invoices.status}</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((txn) => (
            <tr key={txn.id}>
              <td>{txn.transactionDate}</td>
              <td>{txn.description ?? '-'}</td>
              <td className="numeric mono">
                {formatMoney(txn.amountMinor, baseCurrency, locale)}
              </td>
              <td>
                <span className={STATUS_BADGE[txn.status] ?? 'badge'}>
                  {statusLabel[txn.status] ?? txn.status}
                </span>
              </td>
              <td className="actions-cell">
                {txn.status === 'pending' && (
                  <>
                    {matchDropdown === txn.id ? (
                      <div className="match-dropdown">
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => handleSearch(e.target.value)}
                          placeholder="Search transactions..."
                          autoFocus
                        />
                        {searching && <span>{i18n.common.loading}</span>}
                        {searchResults.length > 0 && (
                          <ul>
                            {searchResults.map((r) => (
                              <li key={r.id}>
                                <button
                                  type="button"
                                  onClick={() => handleMatch(txn.id, r.id)}
                                  disabled={acting === txn.id}
                                >
                                  {r.occurredOn} — {r.description}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setMatchDropdown(null);
                            setSearchQuery('');
                            setSearchResults([]);
                          }}
                        >
                          {i18n.common.cancel}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setMatchDropdown(txn.id)}
                        disabled={acting === txn.id}
                      >
                        {i18n.bankImport.match}
                      </button>
                    )}

                    <button
                      type="button"
                      className="text-button"
                      onClick={() => handleIgnore(txn.id)}
                      disabled={acting === txn.id}
                    >
                      {i18n.bankImport.ignore}
                    </button>
                  </>
                )}

                {(txn.status === 'matched' || txn.status === 'ignored') && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => handleReset(txn.id)}
                    disabled={acting === txn.id}
                  >
                    {i18n.bankImport.reset}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
