'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRefreshAfter } from '@/components/ui/use-refresh-after';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { BillListRow } from '@/server/repositories/bills';
import { receiveBill, voidBill } from '@/server/actions/bills';
// 对话框与状态条放在 components/invoices/ 下，是这一轮的文件归属划分所致
// （本轮我只拥有这几个单据目录，没有一个共用目录可放）。发票与账单用的是
// 同一份逻辑，复制第二份必然会在某次改动后走样——宁可跨目录引用一次，
// 也不要两份「作废对话框」。日后应当挪到 components/documents/ 下。
import { DocumentVoidDialog } from '@/components/invoices/document-void-dialog';

type Props = {
  orgSlug: string;
  rows: BillListRow[];
  locale: Locale;
  emptyLabel: string;
  /** 公司时区的「今天」，由页面在服务端算好：逾期按它现推，不落库。 */
  today: string;
};

/** partially_paid 同发票，见 components/invoices/invoice-list.tsx 的注释。 */
const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  received: 'badge badge-info',
  partially_paid: 'badge badge-warning',
  paid: 'badge badge-success',
  overdue: 'badge badge-danger',
  voided: 'badge badge-voided',
};

const OPEN_STATUSES = new Set(['draft', 'received', 'partially_paid', 'overdue']);

export function BillList({ orgSlug, rows, locale, emptyLabel, today }: Props) {
  const t = getMessages(locale);
  // 刷新完成前按钮保持禁用，见 use-refresh-after.ts。
  const { refresh, isRefreshing } = useRefreshAfter();

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<BillListRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="empty-state">{emptyLabel}</p>;
  }

  const statusLabel: Record<string, string> = {
    draft: t.bills.statusDraft,
    received: t.bills.statusReceived,
    partially_paid: t.bills.statusPartiallyPaid,
    paid: t.bills.statusPaid,
    overdue: t.bills.statusOverdue,
    voided: t.bills.statusVoided,
  };

  async function handleReceive(id: string) {
    setPendingId(id);
    setError(null);
    try {
      await receiveBill(orgSlug, id);
      refresh(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  async function handleVoid(reason: string) {
    const target = voidTarget;
    if (!target) return;
    setPendingId(target.id);
    setVoidError(null);
    try {
      await voidBill(orgSlug, target.id, reason);
      setVoidTarget(null);
      refresh(target.id);
    } catch (e) {
      setVoidError((e as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <table className="transaction-table doc-table">
        <caption className="visually-hidden">{t.bills.title}</caption>
        <thead>
          <tr>
            <th scope="col">{t.bills.number}</th>
            <th scope="col">{t.bills.vendor}</th>
            <th scope="col">{t.bills.issueDate}</th>
            <th scope="col">{t.bills.dueDate}</th>
            <th scope="col">{t.bills.status}</th>
            <th scope="col" className="numeric">{t.bills.total}</th>
            <th scope="col">{t.bills.actions}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const status: string = row.status;
            const isVoided = status === 'voided' || row.voidedAt !== null;
            // 逾期从不落库：已接收或部分付款、过了到期日的，徽章上就说「逾期」。
            const shown =
              !isVoided && (status === 'received' || status === 'partially_paid') && row.dueDate < today
                ? 'overdue'
                : status;
            const busy = pendingId === row.id || isRefreshing(row.id);
            // 账单号允许为 null（唯一约束里 null 不参与），而 receiveBill 会
            // 因为分录摘要写不出单据号而拒绝过账。既然服务端一定会拒，
            // 这里就不画那个按钮。
            const hasNumber = (row.billNumber ?? '').trim() !== '';

            return (
              <tr key={row.id} className={isVoided ? 'row-voided' : undefined}>
                <td className="doc-number">
                  <Link href={`/${orgSlug}/bills/${row.id}`}>{row.billNumber ?? '—'}</Link>
                </td>
                <td className="doc-title">{row.contactName}</td>
                <td data-label={t.bills.issueDate}>{row.issueDate}</td>
                <td data-label={t.bills.dueDate}>{row.dueDate}</td>
                <td className="doc-status">
                  <span className={STATUS_CLASS[shown] ?? 'badge'}>
                    {statusLabel[shown] ?? shown}
                  </span>
                </td>
                <td className="numeric money-out doc-amount">{formatMoney(row.totalMinor, row.currency)}</td>
                <td className="doc-actions-cell">
                  <span className="doc-actions">
                    {status === 'draft' && !isVoided && hasNumber ? (
                      <button
                        type="button"
                        className="btn-small"
                        disabled={busy}
                        onClick={() => handleReceive(row.id)}
                      >
                        {t.bills.receive}
                      </button>
                    ) : null}

                    {OPEN_STATUSES.has(status) && !isVoided ? (
                      <Link href={`/${orgSlug}/bills/${row.id}`} className="btn-small">
                        {t.bills.edit}
                      </Link>
                    ) : null}

                    {!isVoided ? (
                      <button
                        type="button"
                        className="btn-small btn-danger"
                        disabled={busy}
                        onClick={() => {
                          setVoidError(null);
                          setVoidTarget(row);
                        }}
                      >
                        {t.bills.void}
                      </button>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <DocumentVoidDialog
        open={voidTarget !== null}
        title={interpolate(t.bills.voidTitle, { number: voidTarget?.billNumber ?? '' })}
        reasonLabel={t.bills.voidReason}
        reasonHint={t.bills.voidReasonHint}
        requiredMessage={t.bills.voidReasonRequired}
        confirmLabel={t.bills.voidConfirm}
        cancelLabel={t.common.cancel}
        pending={pendingId !== null}
        error={voidError}
        onCancel={() => {
          setVoidTarget(null);
          setVoidError(null);
        }}
        onConfirm={handleVoid}
      />
    </>
  );
}
