'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import type { PurchaseOrderRow } from '@/server/repositories/purchase-orders';
import { setPoStatusAction } from '@/server/actions/purchase-orders';
import { ModalDialog } from '@/components/ui/modal-dialog';

type PoStatus = PurchaseOrderRow['status'];

/** 与服务端 assertPoTransition 同一张表：只能往前走，或者作废；关单与作废是终态。 */
const NEXT_STATUS: Record<PoStatus, PoStatus[]> = {
  draft: ['sent', 'voided'],
  sent: ['received', 'voided'],
  received: ['billed', 'closed', 'voided'],
  billed: ['closed', 'voided'],
  closed: [],
  voided: [],
};

type Props = {
  orgSlug: string;
  locale: Locale;
  po: { id: string; poNumber: string; status: PoStatus };
  /** pills：列表卡片里的一排小按钮；rows：详情页底部整行的按钮。 */
  variant: 'pills' | 'rows';
  /** 列表自己持有行状态，改完在本地更新；详情页不传，整页刷新。 */
  onChanged?: (status: PoStatus) => void;
};

/**
 * 采购订单的状态按钮，列表与详情页共用一份。
 *
 * 按钮上写的是动作（「标记为已发送」），不是状态名：原来直接借用
 * statusSent / statusVoided，一排「已发送」「已作废」读起来像是在陈述
 * 现状，而点一下「已作废」就真的把单子作废了。
 *
 * 作废先弹确认框：它不可撤销。这里不像账单那样要求填理由——
 * setPoStatusAction 不收理由，让用户填一段最后被丢掉的话比不问更糟。
 */
export function PoStatusActions({ orgSlug, locale, po, variant, onChanged }: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);

  const next = NEXT_STATUS[po.status] ?? [];
  if (next.length === 0) return null;

  const verb: Record<PoStatus, string> = {
    draft: '',
    sent: t.purchaseOrders.markSent,
    received: t.purchaseOrders.markReceived,
    billed: t.purchaseOrders.markBilled,
    closed: t.purchaseOrders.closeOrder,
    voided: variant === 'rows' ? t.purchaseOrders.voidOrder : t.purchaseOrders.void,
  };

  async function change(status: PoStatus) {
    setPending(true);
    setError(null);
    try {
      await setPoStatusAction(orgSlug, po.id, status);
      setConfirmVoid(false);
      onChanged?.(status);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const forward = next.filter((status) => status !== 'voided');
  const canVoid = next.includes('voided');

  const buttons = (
    <>
      {forward.map((status) => (
        <button
          key={status}
          type="button"
          className={variant === 'rows' ? 'row-button' : 'btn-small'}
          disabled={pending}
          onClick={() => change(status)}
        >
          {verb[status]}
        </button>
      ))}
      {canVoid ? (
        <button
          type="button"
          className={variant === 'rows' ? 'row-button is-destructive' : 'btn-small btn-danger'}
          disabled={pending}
          onClick={() => {
            setError(null);
            setConfirmVoid(true);
          }}
        >
          {verb.voided}
        </button>
      ) : null}
    </>
  );

  return (
    <>
      {variant === 'rows' ? (
        <div className="po-status-actions" role="group" aria-label={t.purchaseOrders.statusActions}>
          {buttons}
        </div>
      ) : (
        <span className="doc-actions">{buttons}</span>
      )}

      {/* 对话框打开时出的错留在对话框里：背后那一句被遮罩盖着，用户看不见。 */}
      {error && !confirmVoid ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <ModalDialog
        open={confirmVoid}
        onClose={() => setConfirmVoid(false)}
        title={interpolate(t.purchaseOrders.voidTitle, { number: po.poNumber })}
      >
        <p className="po-void-body">{t.purchaseOrders.voidBody}</p>
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="app-dialog-actions">
          <button type="button" onClick={() => setConfirmVoid(false)} disabled={pending}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={() => change('voided')}
            disabled={pending}
          >
            {pending ? t.common.loading : t.purchaseOrders.voidConfirm}
          </button>
        </div>
      </ModalDialog>
    </>
  );
}
