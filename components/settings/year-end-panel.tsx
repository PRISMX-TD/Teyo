'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { closeFiscalYear, undoYearEndClose } from '@/server/actions/year_end';

/**
 * 年结面板。
 *
 * 这个组件唯一不能省的设计是「先预览、后执行」：年结会把上一年的利润从
 * 资产负债表的「本年利润」那一行永久搬进留存收益，并且让那一年的损益表
 * 从此不该再变。一个只写着「结转本年度」的按钮，用户点下去之前没有任何
 * 办法知道会发生什么——所以逐行的借贷表是默认展开的，不是折叠在某个
 * 「查看详情」后面。
 *
 * 金额一律以字符串进来、用 BigInt() 转回，全程不经 Number：
 * Server Component 传 bigint 给 Client Component 会在序列化时抛错，
 * 而拿 Number 接一个以分为单位的金额，超过 2^53 就开始悄悄丢精度。
 */

type SerializedLine = {
  accountId: string;
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  accountType: 'revenue' | 'expense' | 'equity';
  direction: 'debit' | 'credit';
  amountMinor: string;
};

type SerializedClosing = {
  id: string;
  periodStart: string;
  periodEnd: string;
  transactionId: string | null;
  netIncomeMinor: string;
  closedAt: string;
  closedBy: string;
  closedByName: string | null;
  transactionVoided: boolean;
};

type SerializedOverview = {
  today: string;
  fiscalYearStartMonth: number;
  currentYear: { start: string; end: string };
  targetYear: { start: string; end: string };
  preview: { lines: SerializedLine[]; netIncomeMinor: string } | null;
  previewError: string | null;
  existingClosing: SerializedClosing | null;
  history: SerializedClosing[];
  lockedUntil: string | null;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  baseCurrency: string;
  overview: SerializedOverview;
  postingAvailable: boolean;
};

export function YearEndPanel({
  orgSlug,
  locale,
  baseCurrency,
  overview,
  postingAvailable,
}: Props) {
  const t = getMessages(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const { targetYear, currentYear, preview, existingClosing } = overview;

  // 财年还没过完就不能结：结一个进行中的年度会把「还会再发生的收入费用」
  // 提前冲平，而第二天记的那一笔又让损益科目重新有余额——那张已经结转过
  // 的损益表从此再也对不上。服务端也挡（见 closeFiscalYear），这里挡是为了
  // 不让按钮看起来可以点。
  const yearEnded = targetYear.end <= overview.today;
  // 年结记在财年最后一天。已经封账到那一天之后的话，postJournal 会拒绝。
  const lockedPastPeriodEnd =
    overview.lockedUntil !== null && overview.lockedUntil >= targetYear.end;

  const canClose =
    existingClosing === null &&
    preview !== null &&
    yearEnded &&
    !lockedPastPeriodEnd &&
    postingAvailable;

  async function runClose() {
    setError(null);
    setPending(true);
    try {
      await closeFiscalYear(orgSlug, { periodStart: targetYear.start });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function runUndo(closing: SerializedClosing) {
    const reason = window.prompt(t.yearEnd.undoReasonPrompt);
    // 取消（null）与留空都不该触发撤销。void_reason 在数据库上有非空要求
    // （transactions_void_fields_together），空字符串会变成一句裸的约束报错。
    if (reason === null || reason.trim() === '') return;

    setError(null);
    setPending(true);
    try {
      await undoYearEndClose(orgSlug, { closingId: closing.id, reason: reason.trim() });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="ye-panel">
      <p className="ye-intro">{t.yearEnd.intro}</p>

      <section className="ye-section">
        <h2>{t.yearEnd.periodTitle}</h2>
        <dl className="ye-facts">
          <dt>{t.yearEnd.targetYear}</dt>
          <dd>
            {targetYear.start} &ndash; {targetYear.end}
          </dd>
          <dt>{t.yearEnd.currentYear}</dt>
          <dd>
            {currentYear.start} &ndash; {currentYear.end}
          </dd>
          <dt>{t.yearEnd.netIncome}</dt>
          <dd className="ye-amount">
            {preview
              ? formatMoney(BigInt(preview.netIncomeMinor), baseCurrency, locale)
              : existingClosing
                ? formatMoney(BigInt(existingClosing.netIncomeMinor), baseCurrency, locale)
                : '—'}
          </dd>
        </dl>
        <p className="field-hint">
          <Link href={`/${orgSlug}/settings/general`}>{t.yearEnd.changeFiscalYear}</Link>
        </p>
      </section>

      {error ? <p className="form-error">{error}</p> : null}

      {existingClosing ? (
        <section className="ye-section">
          <h2>{t.yearEnd.alreadyClosedTitle}</h2>
          <p>
            {interpolate(t.yearEnd.alreadyClosed, {
              start: existingClosing.periodStart,
              end: existingClosing.periodEnd,
              amount: formatMoney(
                BigInt(existingClosing.netIncomeMinor),
                baseCurrency,
                locale,
              ),
            })}
          </p>
          {/* 封账建议而不是自动封账：见文件末尾那段注释。 */}
          <p className="field-hint">{t.yearEnd.lockSuggestion}</p>
          <p className="field-hint">
            <Link href={`/${orgSlug}/settings/general`}>{t.yearEnd.goToLock}</Link>
          </p>
        </section>
      ) : null}

      {preview ? (
        <section className="ye-section">
          <h2>{t.yearEnd.previewTitle}</h2>
          <p className="field-hint">
            {interpolate(t.yearEnd.previewHint, { date: targetYear.end })}
          </p>
          <table className="report-table ye-preview">
            <thead>
              <tr>
                <th>{t.reports.account}</th>
                <th className="numeric">{t.reports.debit}</th>
                <th className="numeric">{t.reports.credit}</th>
              </tr>
            </thead>
            <tbody>
              {preview.lines.map((line) => (
                <tr
                  key={`${line.accountId}-${line.direction}`}
                  className={line.accountType === 'equity' ? 'ye-line-retained' : undefined}
                >
                  <td>{localizedName({ name_en: line.nameEn, name_zh: line.nameZh }, locale)}</td>
                  <td className="numeric mono">
                    {line.direction === 'debit'
                      ? formatMoney(BigInt(line.amountMinor), baseCurrency, locale)
                      : ''}
                  </td>
                  <td className="numeric mono">
                    {line.direction === 'credit'
                      ? formatMoney(BigInt(line.amountMinor), baseCurrency, locale)
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>{t.reports.total}</th>
                <th className="numeric mono">
                  {formatMoney(sumSide(preview.lines, 'debit'), baseCurrency, locale)}
                </th>
                <th className="numeric mono">
                  {formatMoney(sumSide(preview.lines, 'credit'), baseCurrency, locale)}
                </th>
              </tr>
            </tfoot>
          </table>

          {!yearEnded ? (
            <p className="ye-blocked">
              {interpolate(t.yearEnd.notEndedYet, { end: targetYear.end })}
            </p>
          ) : null}
          {lockedPastPeriodEnd ? (
            <p className="ye-blocked">
              {interpolate(t.yearEnd.lockedBlocks, { date: overview.lockedUntil ?? '' })}
            </p>
          ) : null}
          {!postingAvailable ? <p className="ye-blocked">{t.yearEnd.postingUnavailable}</p> : null}

          <p className="ye-warning">{t.yearEnd.confirmWarning}</p>
          <button
            type="button"
            className="primary-button"
            disabled={!canClose || pending}
            onClick={() => {
              // 二次确认。这一步不可逆的程度与作废一笔交易不同：它一次改动
              // 的是整整一年的报表数字，而撤销要 owner 再走一遍并写明理由。
              if (!window.confirm(t.yearEnd.confirmPrompt)) return;
              void runClose();
            }}
          >
            {pending ? t.yearEnd.closing : t.yearEnd.closeButton}
          </button>
        </section>
      ) : overview.previewError && !existingClosing ? (
        <section className="ye-section">
          <h2>{t.yearEnd.previewTitle}</h2>
          <p className="empty-state">{overview.previewError}</p>
        </section>
      ) : null}

      <section className="ye-section">
        <h2>{t.yearEnd.historyTitle}</h2>
        {overview.history.length === 0 ? (
          <p className="empty-state">{t.yearEnd.historyEmpty}</p>
        ) : (
          <table className="report-table">
            <thead>
              <tr>
                <th>{t.yearEnd.period}</th>
                <th className="numeric">{t.yearEnd.netIncome}</th>
                <th>{t.yearEnd.closedBy}</th>
                <th>{t.yearEnd.entry}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overview.history.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.periodStart} &ndash; {row.periodEnd}
                  </td>
                  <td className="numeric mono">
                    {formatMoney(BigInt(row.netIncomeMinor), baseCurrency, locale)}
                  </td>
                  <td>{row.closedByName ?? '—'}</td>
                  <td>
                    {row.transactionId ? (
                      <Link href={`/${orgSlug}/transactions/${row.transactionId}`}>
                        {t.yearEnd.viewEntry}
                      </Link>
                    ) : (
                      '—'
                    )}
                    {row.transactionVoided ? (
                      <span className="badge badge-voided">{t.yearEnd.entryVoided}</span>
                    ) : null}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={pending}
                      onClick={() => void runUndo(row)}
                    >
                      {t.yearEnd.undoButton}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function sumSide(lines: readonly SerializedLine[], direction: 'debit' | 'credit'): bigint {
  return lines
    .filter((line) => line.direction === direction)
    .reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
}
