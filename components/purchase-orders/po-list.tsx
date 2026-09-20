'use client';

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
            {/* 原来这一格的表头借用的是 t.settings.save（「保存修改」）——
                下面放的却是一排状态流转按钮，读屏器把整列念成「保存修改」。 */}
            <th scope="col">{t.purchaseOrders.actions}</th>
          </tr>
        </thead>
        <tbody>
          {pos.map((po) => {
            const next = NEXT_STATUS[po.status] ?? [];
            return (
              <tr key={po.id} className={po.status === 'voided' ? 'row-voided' : undefined}>
                <td>
                  {/* 采购单号不是链接。
                      这里原来链到 `/{orgSlug}/purchase-orders/{id}`，而
                      app/(app)/[orgSlug]/purchase-orders/ 下只有 page.tsx
                      与 new/ 两项——点单号得到的是 404。发票与账单这一轮补上了
                      各自的详情页，采购单还没有（没有 updatePurchaseOrder，
                      改动只有状态流转，而那几个按钮就在这一行的右端）。
                      一个通向 404 的链接比没有链接更糟：它承诺了一个不存在的
                      地方，用户会以为是自己点错了。详情页该补，已在报告里记下。 */}
                  {po.poNumber}
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
                  {/* 行内 style 换成全局类：本项目是纯 CSS + 全局类名，
                      间距由 .doc-actions 的 gap 统一给，不在 JSX 里散落
                      margin。同时这一组按钮在窄屏上能换行而不是溢出。 */}
                  <span className="doc-actions">
                    {next.map((ns) => (
                      <button
                        key={ns}
                        type="button"
                        onClick={() => handleStatusChange(po.id, ns)}
                        disabled={pending}
                        className={ns === 'voided' ? 'btn-small btn-danger' : 'btn-small'}
                      >
                        {statusLabel[ns] ?? ns}
                      </button>
                    ))}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
