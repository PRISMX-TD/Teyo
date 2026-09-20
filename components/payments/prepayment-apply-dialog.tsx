'use client';

import { useMemo, useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { todayLocalISO } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { currencyExponent, formatMinorToDecimal, parseDecimalToMinor } from '@/server/domain/money';
import { applyPrepayment } from '@/server/actions/payments';
import { ModalDialog } from '@/components/shell/modal-dialog';

/** 一笔还挂着钱的预收/预付款。字段与 server/repositories/payments.ts 的 OpenPrepayment 一致。 */
export type OpenPrepaymentView = {
  id: string;
  contactId: string;
  contactName: string;
  type: 'received' | 'made';
  currency: string;
  paymentDate: string;
  reference: string | null;
  unappliedMinor: bigint;
};

/** 一张还有余额的单据。kind 决定它能被哪个方向的款项核销。 */
export type OutstandingDocumentView = {
  id: string;
  kind: 'invoice' | 'bill';
  number: string;
  contactId: string;
  currency: string;
  remainingMinor: bigint;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  payment: OpenPrepaymentView;
  documents: OutstandingDocumentView[];
  onClose: () => void;
  /** 核销成功后由父组件负责 router.refresh()——这个组件不碰路由。 */
  onApplied: () => void;
};

/**
 * 输入框里那个还没打完的十进制字符串 → 最小单位整数；折不动就当零。
 *
 * 与 payment-form.tsx 里那一份逐字相同，理由也相同（见那里的注释）：
 * 绝不 parseFloat——这里的每一个值最终都会变成账上的一个数，而 0.1 + 0.2
 * 在浮点下不是 0.3。折不动时返回 0 而不是抛：这个函数在每一次按键上都会
 * 跑一遍，打到一半的 '12.' 不是错误，只是还没打完。
 *
 * 为什么不抽成共享模块：它是**客户端的显示辅助**，真正的校验在服务端，
 * 而两个组件对「折不动怎么办」的期望恰好相同只是巧合——把它抽出去会让
 * 下一个需要「折不动就报错」的表单误用它。八行的重复比一个错误的抽象好。
 */
function minorOrZero(value: string, exponent: number): bigint {
  const trimmed = value.trim();
  if (trimmed === '') return 0n;
  try {
    return parseDecimalToMinor(trimmed, exponent);
  } catch {
    return 0n;
  }
}

/**
 * 把一笔挂账的预收/预付核销到单据上。
 *
 * 这一步是预收款生命周期里缺不得的后半截：只能收定金、不能核销，等于把
 * 钱永远挂在负债上——预收账款会一年比一年大，而客户明明早就收到货、
 * 发票也开了。
 *
 * 界面上刻意只列**这位往来对象、这个币种**的未结单据：
 *   - 别人的单据用这笔定金去冲，业务上无法解释；
 *   - 币种不同的，服务端会直接拒（核销的是当初那笔钱，它是什么币种就只能
 *     按什么币种核销），列出来只是让用户白点一次。
 */
export function PrepaymentApplyDialog({
  orgSlug,
  locale,
  i18n,
  payment,
  documents,
  onClose,
  onApplied,
}: Props) {
  const t = getMessages(locale);
  const exponent = currencyExponent(payment.currency);
  const amountStep = exponent === 0 ? '1' : '0.01';

  const [date, setDate] = useState(todayLocalISO());
  /** 单据 id -> 核销金额（用户敲的原始字符串，绝不在这里折算成数字再折回去）。 */
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const documentKind = payment.type === 'received' ? 'invoice' : 'bill';

  const candidates = useMemo(
    () =>
      documents.filter(
        (doc) =>
          doc.kind === documentKind &&
          doc.contactId === payment.contactId &&
          doc.currency === payment.currency &&
          doc.remainingMinor > 0n,
      ),
    [documents, documentKind, payment.contactId, payment.currency],
  );

  const appliedMinor = useMemo(
    () =>
      Object.values(amounts).reduce((sum, value) => sum + minorOrZero(value, exponent), 0n),
    [amounts, exponent],
  );

  const overBalance = appliedMinor > payment.unappliedMinor;

  function toggle(doc: OutstandingDocumentView) {
    setAmounts((prev) => {
      if (doc.id in prev) {
        const next = { ...prev };
        delete next[doc.id];
        return next;
      }
      /**
       * 预填成「单据余额」与「这笔款剩下的挂账余额」里较小的那个。
       *
       * 预填单据余额是常态（一笔定金正好抵掉一张发票）；但定金只剩 300、
       * 发票欠 1,000 时，预填 1,000 送出去必然被服务端拒（超出可核销
       * 余额）——而那是这个对话框最常见的一种用法：把定金用完。
       */
      const cap =
        doc.remainingMinor < payment.unappliedMinor ? doc.remainingMinor : payment.unappliedMinor;
      return { ...prev, [doc.id]: formatMinorToDecimal(cap, exponent) };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const items = Object.entries(amounts)
      .filter(([, value]) => minorOrZero(value, exponent) > 0n)
      .map(([id, value]) =>
        documentKind === 'invoice'
          ? { invoiceId: id, billId: null, amount: value }
          : { invoiceId: null, billId: id, amount: value },
      );

    if (items.length === 0) {
      setError(i18n.payments.applyNothingSelected);
      return;
    }
    if (overBalance) {
      setError(
        interpolate(i18n.payments.applyOverBalance, {
          balance: formatMoney(payment.unappliedMinor, payment.currency),
          applied: formatMoney(appliedMinor, payment.currency),
        }),
      );
      return;
    }

    setPending(true);
    setError(null);
    try {
      await applyPrepayment(orgSlug, {
        paymentId: payment.id,
        applicationDate: date,
        items,
      });
      onApplied();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalDialog
      open
      onClose={onClose}
      title={i18n.payments.applyTitle}
      className="app-dialog--wide"
    >
      <form onSubmit={handleSubmit}>
        <p className="field-hint">
          {payment.contactName} · {payment.paymentDate}
          {payment.reference ? ` · ${payment.reference}` : ''}
        </p>
        <p className="pp-apply-balance" role="status">
          {interpolate(i18n.payments.applyAvailable, {
            amount: formatMoney(payment.unappliedMinor, payment.currency),
          })}
        </p>

        <label htmlFor="applicationDate">{i18n.payments.applyDate}</label>
        <input
          id="applicationDate"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />

        <fieldset>
          <legend>
            {payment.type === 'received'
              ? i18n.payments.applyToInvoices
              : i18n.payments.applyToBills}
          </legend>

          {candidates.length === 0 ? (
            <p className="field-hint">
              {interpolate(i18n.payments.applyNoDocuments, { currency: payment.currency })}
            </p>
          ) : (
            candidates.map((doc) => {
              const selected = doc.id in amounts;
              return (
                <label key={doc.id} className="checkbox-row">
                  <input type="checkbox" checked={selected} onChange={() => toggle(doc)} />
                  <span>
                    {doc.number} ({formatMoney(doc.remainingMinor, doc.currency)})
                  </span>
                  {selected ? (
                    <input
                      type="number"
                      min="0"
                      step={amountStep}
                      aria-label={`${i18n.transaction.amount} ${doc.number}`}
                      value={amounts[doc.id]}
                      onChange={(e) =>
                        setAmounts((prev) => ({ ...prev, [doc.id]: e.target.value }))
                      }
                    />
                  ) : null}
                </label>
              );
            })
          )}
        </fieldset>

        {/* 合计一直显示，不只在超额时才出现：用户需要在按下核销之前就看得出
            「我勾的这几张加起来是多少」，否则超额这件事只能靠服务端在一个
            来回之后告诉他。role="status" 而不是 alert——它多数时候陈述的是
            一个正常的数。 */}
        <p className="field-hint" role="status">
          {i18n.payments.appliedTotal}: {formatMoney(appliedMinor, payment.currency)}
        </p>

        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}

        <div className="app-dialog-actions">
          <button type="button" className="text-button" onClick={onClose} disabled={pending}>
            {t.common.cancel}
          </button>
          <button type="submit" disabled={pending || candidates.length === 0}>
            {pending ? t.common.loading : i18n.payments.applySubmit}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
