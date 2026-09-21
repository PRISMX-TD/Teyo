'use client';

import { useMemo, useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { ImportedTransactionRow } from '@/server/repositories/bank_import';
import {
  matchTransaction,
  ignoreImportedAction,
  postImportedTransactions,
  resetImportedAction,
} from '@/server/actions/bank_import';

type MoneyAccountOption = {
  id: string;
  name_en: string | null;
  name_zh: string | null;
};

/** 可供选择的分类。kind 决定它能配给哪个方向的流水。 */
export type CategoryOption = {
  id: string;
  nameEn: string | null;
  nameZh: string | null;
  kind: 'income' | 'expense';
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
  /**
   * 收入/支出两种分类。可选，缺省为空——为空时「生成交易」那一列整个不
   * 渲染，因为没有分类可选时这个操作一定失败，而失败的原因（这家公司一个
   * 分类都没有）不是在这个页面上解决得了的。
   */
  categories?: CategoryOption[];
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
  categories,
}: Props) {
  const [moneyAccountFilter, setMoneyAccountFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [matchDropdown, setMatchDropdown] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  /** 导入行 id -> 用户给它选的分类 id。 */
  const [chosenCategory, setChosenCategory] = useState<Record<string, string>>({});
  /** 批量勾选的导入行 id。 */
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [postNotice, setPostNotice] = useState<string | null>(null);

  // `categories ?? []` 每次渲染都产生一个**新数组**，于是下面两个 useMemo
  // 的依赖每次都变，缓存从来没有命中过——写了 useMemo 却等于没写。
  // 把这一步本身也 memo 掉，缓存才真的成立。
  const categoryOptions = useMemo(() => categories ?? [], [categories]);
  const canPost = categoryOptions.length > 0;

  // 一行流水的方向由**金额的正负**决定，不由用户再选一次：对账单上的符号
  // 是银行说的，让用户选等于给了一个把它说反的机会，而说反之后金额依然
  // 配平，报表上只是利润多了两倍。所以分类选择器也按符号过滤——把一笔
  // 入账配上「租金」这种支出分类，服务端会拒，而那一句报错本可以不必出现。
  const incomeCategories = useMemo(
    () => categoryOptions.filter((c) => c.kind === 'income'),
    [categoryOptions],
  );
  const expenseCategories = useMemo(
    () => categoryOptions.filter((c) => c.kind === 'expense'),
    [categoryOptions],
  );

  /** 勾了、还是 pending、而且已经选好分类的那些行——批量按钮真正会提交的集合。 */
  const postableIds = useMemo(
    () =>
      importedTxns
        .filter(
          (txn) =>
            txn.status === 'pending' &&
            ticked[txn.id] === true &&
            (chosenCategory[txn.id] ?? '') !== '',
        )
        .map((txn) => txn.id),
    [importedTxns, ticked, chosenCategory],
  );

  async function handlePost(ids: string[]) {
    if (ids.length === 0) {
      setPostError(i18n.bankImport.createNone);
      setPostNotice(null);
      return;
    }

    setPosting(true);
    setPostError(null);
    setPostNotice(null);
    try {
      const result = await postImportedTransactions(orgSlug, {
        entries: ids.map((id) => ({
          importedTransactionId: id,
          categoryId: chosenCategory[id],
        })),
      });
      setPostNotice(
        interpolate(i18n.bankImport.createdCount, {
          created: String(result.created),
          skipped: String(result.skipped),
        }),
      );
      // 勾选与分类都清掉：这些行已经不是 pending 了，留着它们的状态只会让
      // 下一次批量把一批已处理的行再送一遍（服务端会跳过，但用户看到的
      // 「已生成 0 笔」解释不了任何事）。
      //
      // 列表本身不用在这里手工刷新：postImportedTransactions 里的
      // revalidatePath 会让这个页面的 Server Component 重新渲染并把新的
      // importedTxns 传下来——与本文件其余三个动作（匹配/忽略/重置）
      // 用的是同一条路径。
      setTicked({});
      setChosenCategory({});
    } catch (e) {
      setPostError((e as Error).message || i18n.bankImport.createFailed);
    } finally {
      setPosting(false);
    }
  }

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

      {/*
        从对账单行直接生成交易。

        改动之前，这个页面只能「对号入座」——把导进来的行匹配到用户已经
        手工记过的交易上。也就是说银行导入的用法是「先自己记一遍，再导进来
        核对」。而最省事的用法恰恰是反过来：对账单上有的，直接变成一笔账，
        人只需要回答「这是什么开销」。这一块就是那个反方向。
      */}
      {canPost ? (
        <div className="pp-import-batch">
          <p className="field-hint">{i18n.bankImport.createHint}</p>
          <button
            type="button"
            onClick={() => handlePost(postableIds)}
            disabled={posting || postableIds.length === 0}
          >
            {posting
              ? i18n.common.loading
              : interpolate(i18n.bankImport.createSelected, {
                  count: String(postableIds.length),
                })}
          </button>
          {postError ? (
            <p role="alert" className="form-error">
              {postError}
            </p>
          ) : null}
          {postNotice ? (
            <p role="status" className="field-hint">
              {postNotice}
            </p>
          ) : null}
        </div>
      ) : null}

      <table className="report-table">
        <thead>
          <tr>
            {canPost ? (
              // 空表头的整一列在读屏器里是没有名字的：按列导航时念到这里
              // 只有「空白」。勾选列也要有名字，哪怕它在视觉上不需要。
              <th>
                <span className="visually-hidden">{i18n.bankImport.selectLine}</span>
              </th>
            ) : null}
            <th>{i18n.transaction.date}</th>
            <th>{i18n.transaction.description}</th>
            <th className="numeric">{i18n.transaction.amount}</th>
            {canPost ? <th>{i18n.bankImport.category}</th> : null}
            <th>{i18n.invoices.status}</th>
            <th>{i18n.common.actions}</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((txn) => (
            <tr key={txn.id}>
              {canPost ? (
                <td>
                  {txn.status === 'pending' ? (
                    <input
                      type="checkbox"
                      aria-label={`${i18n.bankImport.selectLine} ${txn.transactionDate} ${txn.description ?? ''}`}
                      checked={ticked[txn.id] === true}
                      onChange={(e) =>
                        setTicked((prev) => ({ ...prev, [txn.id]: e.target.checked }))
                      }
                    />
                  ) : null}
                </td>
              ) : null}
              <td>{txn.transactionDate}</td>
              <td>{txn.description ?? '-'}</td>
              <td className="numeric mono">
                {formatMoney(txn.amountMinor, baseCurrency, locale)}
              </td>
              {canPost ? (
                <td>
                  {txn.status === 'pending' ? (
                    <select
                      aria-label={`${i18n.bankImport.category} ${txn.transactionDate} ${txn.description ?? ''}`}
                      value={chosenCategory[txn.id] ?? ''}
                      onChange={(e) =>
                        setChosenCategory((prev) => ({ ...prev, [txn.id]: e.target.value }))
                      }
                    >
                      <option value="">{i18n.bankImport.categoryPrompt}</option>
                      {(txn.amountMinor > 0n ? incomeCategories : expenseCategories).map((c) => (
                        <option key={c.id} value={c.id}>
                          {localizedName({ name_en: c.nameEn, name_zh: c.nameZh }, locale)}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </td>
              ) : null}
              <td>
                <span className={STATUS_BADGE[txn.status] ?? 'badge'}>
                  {statusLabel[txn.status] ?? txn.status}
                </span>
              </td>
              <td className="actions-cell">
                {txn.status === 'pending' && canPost && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => handlePost([txn.id])}
                    // 没选分类就禁用：这一步一定失败，而「请选分类」这件事
                    // 就摆在左边那一格里，一个灰掉的按钮在这里说得清。
                    disabled={posting || (chosenCategory[txn.id] ?? '') === ''}
                  >
                    {i18n.bankImport.createTransaction}
                  </button>
                )}

                {txn.status === 'pending' && (
                  <>
                    {matchDropdown === txn.id ? (
                      <div className="match-dropdown">
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => handleSearch(e.target.value)}
                          placeholder={i18n.bankImport.searchPlaceholder}
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
