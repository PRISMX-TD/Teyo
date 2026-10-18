'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { PurchaseOrderRow } from '@/server/repositories/purchase-orders';
import { PoStatusActions } from '@/components/purchase-orders/po-status-actions';

type Props = {
  orgSlug: string;
  locale: Locale;
  purchaseOrders: PurchaseOrderRow[];
  /** 公司本位币。合计这一列读的是 base_total_minor，它是本位币。 */
  baseCurrency: string;
  /** setPoStatusAction 要 transaction:edit:any；没有的人不画那排必然失败的按钮。 */
  canChangeStatus: boolean;
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  sent: 'badge badge-info',
  received: 'badge badge-success',
  billed: 'badge badge-info',
  closed: 'badge badge-success',
  voided: 'badge badge-voided',
};

export function PoList({ orgSlug, locale, purchaseOrders: initialPos, baseCurrency, canChangeStatus }: Props) {
  const t = getMessages(locale);
  const [pos, setPos] = useState(initialPos);

  const statusLabel: Record<string, string> = {
    draft: t.purchaseOrders.statusDraft,
    sent: t.purchaseOrders.statusSent,
    received: t.purchaseOrders.statusReceived,
    billed: t.purchaseOrders.statusBilled,
    closed: t.purchaseOrders.statusClosed,
    voided: t.purchaseOrders.statusVoided,
  };

  if (pos.length === 0) {
    return <p className="empty-state">{t.purchaseOrders.empty}</p>;
  }

  return (
    <>
      <table className="transaction-table doc-table">
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
          {pos.map((po) => (
            <tr key={po.id} className={po.status === 'voided' ? 'row-voided' : undefined}>
              <td className="doc-number">
                {/* 单号链到详情/编辑页。
                    这里曾经是一段纯文本，因为链接指向的路由不存在——点单号
                    得到的是 404，而一个通向 404 的链接比没有链接更糟：它
                    承诺了一个不存在的地方。现在
                    app/(app)/[orgSlug]/purchase-orders/[id]/page.tsx 补上了，
                    链接与路由是同一次改动的两半，必须同时到位。 */}
                <Link href={`/${orgSlug}/purchase-orders/${po.id}`}>{po.poNumber}</Link>
              </td>
              <td className="doc-title">{po.contactName ?? '-'}</td>
              <td data-label={t.purchaseOrders.issueDate}>{po.issueDate}</td>
              <td
                data-label={t.purchaseOrders.expectedDate}
                className={po.expectedDate ? undefined : 'doc-blank'}
              >
                {po.expectedDate ?? '-'}
              </td>
              {/* base_total_minor 是本位币（见 server/actions/purchase-orders.ts
                  的 totalsFor）。原来按单据币种格式化：一张 USD 1,000 的
                  采购单在 MYR 公司里显示成 US$ 4,350。 */}
              <td className="numeric money-out doc-amount">
                {formatMoney(po.baseTotalMinor, baseCurrency, locale)}
              </td>
              <td className="doc-status">
                <span className={STATUS_CLASS[po.status] ?? 'badge'}>
                  {statusLabel[po.status] ?? po.status}
                </span>
              </td>
              <td className="doc-actions-cell">
                {/* 状态按钮（动词 + 作废确认）与详情页共用 PoStatusActions。 */}
                {canChangeStatus ? (
                  <PoStatusActions
                    orgSlug={orgSlug}
                    locale={locale}
                    po={po}
                    variant="pills"
                    onChanged={(status) =>
                      setPos((prev) => prev.map((p) => (p.id === po.id ? { ...p, status } : p)))
                    }
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
