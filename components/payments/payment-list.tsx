'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { PaymentRow } from '@/server/repositories/payments';
import { voidPaymentAction } from '@/server/actions/payments';
import {
  PrepaymentApplyDialog,
  type OpenPrepaymentView,
  type OutstandingDocumentView,
} from '@/components/payments/prepayment-apply-dialog';

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  payments: PaymentRow[];
  contacts: { id: string; name: string }[];
  /**
   * 还挂着钱的预收/预付款。可选，缺省为空——传不传由页面决定，这个组件
   * 不该因为少一个 prop 就崩掉（收付款列表在别处也被复用过）。
   */
  openPrepayments?: OpenPrepaymentView[];
  /** 可供核销的未结单据（发票 + 账单），对话框里按往来对象与币种再过滤。 */
  outstandingDocuments?: OutstandingDocumentView[];
};

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  online: 'Online',
  other: 'Other',
};

export function PaymentList({
  orgSlug,
  locale,
  i18n,
  payments,
  contacts,
  openPrepayments,
  outstandingDocuments,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const [typeFilter, setTypeFilter] = useState<'all' | 'received' | 'made'>('all');
  const [contactFilter, setContactFilter] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  // 只禁用被点的那一行，不锁整张表。
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** 正在核销的那一笔预收款；null 表示对话框关着。 */
  const [applying, setApplying] = useState<OpenPrepaymentView | null>(null);

  const prepayments = openPrepayments ?? [];
  const documents = outstandingDocuments ?? [];

  const filtered = payments.filter((p) => {
    if (typeFilter !== 'all' && p.type !== typeFilter) return false;
    if (contactFilter !== 'all' && p.contactId !== contactFilter) return false;
    return true;
  });

  async function handleVoid(id: string) {
    if (!confirm(t.common.confirm + '?')) return;
    setPendingId(id);
    setError(null);
    try {
      await voidPaymentAction(orgSlug, id);
      router.refresh();
    } catch (e) {
      // 原来这里是 `catch { /* ignore */ }`。作废一笔收款会反向过账三笔分录
      // （收款本身 + 汇兑收益 + 汇兑损失），期间封账、权限不足、单据已经
      // 结转都会抛错——而用户看到的只是「点了没反应」。更糟的是这一行
      // **看上去**还没作废，他会再点一次，以为是自己手滑。
      setError((e as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  if (payments.length === 0) {
    return (
      <>
        <p className="empty-state">{i18n.payments.empty}</p>
        <Link href={`/${orgSlug}/payments/new`} className="primary-button">
          {i18n.payments.newTitle}
        </Link>
      </>
    );
  }

  return (
    <>
      <Link href={`/${orgSlug}/payments/new`} className="primary-button">
        {i18n.payments.newTitle}
      </Link>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      {/*
        挂账的款项单独成一块，不是表里的一列。

        理由是它要回答的问题不一样：收付款表回答「这段时间收付了哪些钱」，
        而这一块回答「哪几笔钱还悬在半空、我现在能拿它去冲哪张单」。后者
        是一份待办，混进一张按日期排的流水表里就看不见了——而看不见正是
        预收款最大的风险：一笔一年前的定金没人记得核销，预收账款就一直
        虚高，客户也一直显示欠款。
      */}
      {prepayments.length > 0 ? (
        <section className="pp-open-list">
          <h2>{i18n.payments.openPrepayments}</h2>
          <p className="field-hint">{i18n.payments.openPrepaymentsHint}</p>
          <ul>
            {prepayments.map((prepayment) => (
              <li key={prepayment.id}>
                <span>
                  {prepayment.paymentDate} · {prepayment.contactName} ·{' '}
                  <span
                    className={
                      prepayment.type === 'received'
                        ? 'badge badge-success'
                        : 'badge badge-danger'
                    }
                  >
                    {prepayment.type === 'received' ? i18n.payments.received : i18n.payments.made}
                  </span>
                </span>
                <strong className="mono">
                  {formatMoney(prepayment.unappliedMinor, prepayment.currency)}
                </strong>
                <button
                  type="button"
                  className="btn-small"
                  onClick={() => setApplying(prepayment)}
                >
                  {i18n.payments.apply}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {applying ? (
        <PrepaymentApplyDialog
          orgSlug={orgSlug}
          locale={locale}
          i18n={i18n}
          payment={applying}
          documents={documents}
          onClose={() => setApplying(null)}
          onApplied={() => {
            setApplying(null);
            // 核销改了三处：预收余额、单据状态、总账。整页刷新最省事，
            // 也最不容易漏——手工改本地 state 只会让这三处各自漂移。
            router.refresh();
          }}
        />
      ) : null}

      <div className="filters">
        <label>
          {i18n.payments.type}
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
            <option value="all">{i18n.payments.all}</option>
            <option value="received">{i18n.payments.received}</option>
            <option value="made">{i18n.payments.made}</option>
          </select>
        </label>

        <label>
          {i18n.invoices.customer}
          <select value={contactFilter} onChange={(e) => setContactFilter(e.target.value)}>
            <option value="all">{i18n.payments.all}</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      <table className="transaction-table">
        <caption className="visually-hidden">{i18n.payments.title}</caption>
        <thead>
          <tr>
            <th scope="col">{i18n.transaction.date}</th>
            <th scope="col">{i18n.invoices.customer}</th>
            <th scope="col">{i18n.transaction.kind}</th>
            <th scope="col" className="numeric">{i18n.transaction.amount}</th>
            <th scope="col">{i18n.payments.method}</th>
            <th scope="col">{i18n.payments.reference}</th>
            <th scope="col">{i18n.invoices.status}</th>
            {/* 空表头的整一列在读屏器里是没有名字的：按列导航时念到这里
                只有「空白」。操作列也要有名字。 */}
            <th scope="col">{i18n.payments.actions}</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id} className={p.voidedAt ? 'row-voided' : undefined}>
              <td>{p.paymentDate}</td>
              <td>{p.contactName ?? '-'}</td>
              <td>
                <span className={p.type === 'received' ? 'badge badge-success' : 'badge badge-danger'}>
                  {p.type === 'received' ? i18n.payments.received : i18n.payments.made}
                </span>
              </td>
              <td className="numeric">
                {formatMoney(p.amountMinor, p.currency)}
              </td>
              <td>{METHOD_LABELS[p.method] ?? p.method}</td>
              <td>{p.reference ?? '-'}</td>
              <td>
                {p.voidedAt ? (
                  <span className="badge badge-voided">{i18n.payments.voided}</span>
                ) : (
                  <span className="badge badge-success">{i18n.invoices.statusPaid}</span>
                )}
              </td>
              <td>
                {!p.voidedAt ? (
                  <button
                    type="button"
                    className="btn-small btn-danger"
                    disabled={pendingId === p.id}
                    onClick={() => handleVoid(p.id)}
                  >
                    {i18n.transaction.void}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
