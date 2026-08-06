'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { PurchaseOrderRow } from '@/server/repositories/purchase_orders';
import { setPoStatusAction } from '@/server/actions/purchase_orders';

type Props = {
  orgSlug: string;
  locale: Locale;
  purchaseOrders: PurchaseOrderRow[];
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  sent: 'badge badge-info',
  received: 'badge badge-success',
  billed: 'badge badge-info',
  closed: 'badge badge-success',
  voided: 'badge badge-voided',
};

const NEXT_STATUS: Record<string, string[]> = {
  draft: ['sent', 'voided'],
  sent: ['received', 'voided'],
  received: ['billed', 'closed', 'voided'],
  billed: ['closed', 'voided'],
  closed: [],
  voided: [],
};

export function PoList({ orgSlug, locale, purchaseOrders: initialPos }: Props) {
  const t = getMessages(locale);
  const [pos, setPos] = useState(initialPos);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusLabel: Record<string, string> = {
    draft: t.purchaseOrders.statusDraft,
    sent: t.purchaseOrders.statusSent,
    received: t.purchaseOrders.statusReceived,
    billed: t.purchaseOrders.statusBilled,
    closed: t.purchaseOrders.statusClosed,
    voided: t.purchaseOrders.statusVoided,
  };

  async function handleStatusChange(id: string, newStatus: string) {
    setPending(true);
    setError(null);
    try {
      await setPoStatusAction(orgSlug, id, newStatus as PurchaseOrderRow['status']);
      setPos((prev) =>
        prev.map((po) =>
          po.id === id ? { ...po, status: newStatus as PurchaseOrderRow['status'] } : po,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (pos.length === 0) {
    return <p className="empty-state">{t.purchaseOrders.empty}</p>;
  }

  return (
    <>
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      <table className="transaction-table">
        <caption className="visually-hidden">{t.purchaseOrders.title}</caption>
        <thead>
          <tr>
            <th scope="col">{t.purchaseOrders.poNumber}</th>
            <th scope="col">{t.purchaseOrders.vendor}</th>
            <th scope="col">{t.purchaseOrders.issueDate}</th>
            <th scope="col">{t.purchaseOrders.expectedDate}</th>
            <th scope="col" className="numeric">{t.purchaseOrders.total}</th>
            <th scope="col">{t.purchaseOrders.status}</th>
            <th scope="col">{t.settings.save}</th>
          </tr>
        </thead>
        <tbody>
          {pos.map((po) => {
            const next = NEXT_STATUS[po.status] ?? [];
            return (
              <tr key={po.id} className={po.status === 'voided' ? 'row-voided' : undefined}>
                <td>
                  <Link href={`/${orgSlug}/purchase-orders/${po.id}`}>{po.poNumber}</Link>
                </td>
                <td>{po.contactName ?? '-'}</td>
                <td>{po.issueDate}</td>
                <td>{po.expectedDate ?? '-'}</td>
                <td className="numeric money-out">
                  {formatMoney(po.baseTotalMinor, po.currency)}
                </td>
                <td>
                  <span className={STATUS_CLASS[po.status] ?? 'badge'}>
                    {statusLabel[po.status] ?? po.status}
                  </span>
                </td>
                <td>
                  {next.map((ns) => (
                    <button
                      key={ns}
                      onClick={() => handleStatusChange(po.id, ns)}
                      disabled={pending}
                      className="btn-small"
                      style={{ marginRight: 4 }}
                    >
                      {statusLabel[ns] ?? ns}
                    </button>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
