'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { InvoiceListRow } from '@/server/repositories/invoices';
import { issueInvoice, voidInvoice } from '@/server/actions/invoices';
import { DocumentVoidDialog } from '@/components/invoices/document-void-dialog';

type Props = {
  orgSlug: string;
  rows: InvoiceListRow[];
  locale: Locale;
  emptyLabel: string;
};

/**
 * 状态徽章。
 *
 * partially_paid 是 0009 给 invoice_status 枚举加的值，数据库里确实会出现
 * （refreshSettlementStatuses 在部分收款时就写这个值），但前端此前没处理，
 * 于是一张收了一半的发票在列表上显示的是原样的 `partially_paid` 字符串。
 * 它用 warning 而不是 success：钱还没收齐，这一行还需要有人跟进。
 *
 * 注意 server/repositories/invoices.ts 的 InvoiceStatus 联合类型里**也没有**
 * partially_paid，与数据库枚举对不上。所以这里一律按 string 索引，而不是用
 * Record<InvoiceStatus, …>——后者会让 TypeScript 以为这个分支不可能存在，
 * 而它每天都在发生。（类型该补，但那是 server/ 下的文件。）
 */
const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  sent: 'badge badge-info',
  partially_paid: 'badge badge-warning',
  paid: 'badge badge-success',
  overdue: 'badge badge-danger',
  voided: 'badge badge-voided',
};

/** 还能改、还能作废的状态。voided 与 paid 之外的都算「在途」。 */
const OPEN_STATUSES = new Set(['draft', 'sent', 'partially_paid', 'overdue']);

export function InvoiceList({ orgSlug, rows, locale, emptyLabel }: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  // 正在处理的那一行。用 id 而不是布尔：只该禁用被点的那一行的按钮，
  // 把整张表锁住会让用户以为页面挂了。
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<InvoiceListRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="empty-state">{emptyLabel}</p>;
  }

  const statusLabel: Record<string, string> = {
    draft: t.invoices.statusDraft,
    sent: t.invoices.statusSent,
    partially_paid: t.invoices.statusPartiallyPaid,
    paid: t.invoices.statusPaid,
    overdue: t.invoices.statusOverdue,
    voided: t.invoices.statusVoided,
  };

  async function handleIssue(id: string) {
    setPendingId(id);
    setError(null);
    try {
      await issueInvoice(orgSlug, id);
      // 服务端 revalidatePath 之后还要 refresh：那个调用刷的是服务端缓存，
      // 当前这个已经渲染好的客户端组件不会自己重新取数。
      router.refresh();
    } catch (e) {
      // 原来这一类 catch 在别处写的是 `catch { /* ignore */ }`——过账失败
      // （期间封账、科目没配、权限不足）会表现为「点了没反应」。必须说出来。
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
      await voidInvoice(orgSlug, target.id, reason);
      setVoidTarget(null);
      router.refresh();
    } catch (e) {
      // 错误留在对话框里，对话框不关：关掉的话用户刚打的理由就没了。
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

      <table className="transaction-table">
        <caption className="visually-hidden">{t.invoices.title}</caption>
        <thead>
          <tr>
            <th scope="col">{t.invoices.number}</th>
            <th scope="col">{t.invoices.customer}</th>
            <th scope="col">{t.invoices.issueDate}</th>
            <th scope="col">{t.invoices.dueDate}</th>
            <th scope="col">{t.invoices.status}</th>
            <th scope="col" className="numeric">{t.invoices.total}</th>
            <th scope="col">{t.invoices.actions}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // InvoiceStatus 里没有 partially_paid（见上面 STATUS_CLASS 的注释），
            // 直接 `row.status === 'partially_paid'` 会被 TypeScript 判成
            // 「两个类型没有重叠」而报错。放宽成 string 是如实描述运行时。
            const status: string = row.status;
            const isVoided = status === 'voided' || row.voidedAt !== null;
            const busy = pendingId === row.id;

            return (
              <tr key={row.id} className={isVoided ? 'row-voided' : undefined}>
                <td>
                  <Link href={`/${orgSlug}/invoices/${row.id}`}>{row.invoiceNumber}</Link>
                </td>
                <td>{row.contactName}</td>
                <td>{row.issueDate}</td>
                <td>{row.dueDate}</td>
                <td>
                  <span className={STATUS_CLASS[status] ?? 'badge'}>
                    {statusLabel[status] ?? status}
                  </span>
                </td>
                <td className="numeric money-out">{formatMoney(row.totalMinor, row.currency)}</td>
                <td>
                  <span className="doc-actions">
                    {/* 开具只在草稿上出现。issueInvoice 对其余状态一律抛错，
                        把按钮画出来再让服务端拒绝，等于请用户去点一个坏按钮。 */}
                    {status === 'draft' && !isVoided ? (
                      <button
                        type="button"
                        className="btn-small"
                        disabled={busy}
                        onClick={() => handleIssue(row.id)}
                      >
                        {t.invoices.issue}
                      </button>
                    ) : null}

                    {/* 编辑对已过账的发票同样开放：updateInvoice 会走
                        repostJournal 重建分录，这是它存在的全部理由。
                        已收讫的不给入口——改动金额会让收款对不上。 */}
                    {OPEN_STATUSES.has(status) && !isVoided ? (
                      <Link href={`/${orgSlug}/invoices/${row.id}`} className="btn-small">
                        {t.invoices.edit}
                      </Link>
                    ) : null}

                    {/* 作废：草稿也给。发票没有删除动作（账本不删行），
                        一张开错的草稿只能作废——它没有分录，作废就只是
                        改状态加理由，不会在总账上留任何东西。 */}
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
                        {t.invoices.void}
                      </button>
                    ) : null}

                    <a
                      href={`/api/invoice/${row.id}/pdf?orgSlug=${orgSlug}`}
                      download
                      className="text-button"
                    >
                      {t.invoicePdf.download}
                    </a>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <DocumentVoidDialog
        open={voidTarget !== null}
        title={interpolate(t.invoices.voidTitle, { number: voidTarget?.invoiceNumber ?? '' })}
        reasonLabel={t.invoices.voidReason}
        reasonHint={t.invoices.voidReasonHint}
        requiredMessage={t.invoices.voidReasonRequired}
        confirmLabel={t.invoices.voidConfirm}
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
