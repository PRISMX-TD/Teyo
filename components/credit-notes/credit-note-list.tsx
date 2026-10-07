'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { CreditNoteListRow } from '@/server/repositories/credit-notes';
import {
  issueCreditNote,
  applyCreditNote,
  voidCreditNote,
} from '@/server/actions/credit-notes';
import { DocumentVoidDialog } from '@/components/invoices/document-void-dialog';

type Props = {
  orgSlug: string;
  locale: Locale;
  /** 公司本位币。列表里那一栏金额记的是本位币，不是单据自己的币种。 */
  baseCurrency: string;
  i18n: Messages;
  creditNotes: CreditNoteListRow[];
  /** 签发 / 抵扣 / 作废都要 transaction:create。viewer 不画这些按钮。 */
  canWrite: boolean;
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  issued: 'badge badge-info',
  applied: 'badge badge-success',
  voided: 'badge badge-voided',
};

export function CreditNoteList({
  orgSlug,
  locale,
  baseCurrency,
  i18n,
  creditNotes,
  canWrite,
}: Props) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 作废原来是点一下就生效：不可逆、不问一句、也不留理由。与发票一样走
  // DocumentVoidDialog，理由跟着分录一起留下。
  const [voidTarget, setVoidTarget] = useState<CreditNoteListRow | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);

  if (creditNotes.length === 0) {
    return <p className="empty-state">{i18n.creditNotes.empty}</p>;
  }

  const statusLabel: Record<string, string> = {
    draft: i18n.creditNotes.statusDraft,
    issued: i18n.creditNotes.statusIssued,
    applied: i18n.creditNotes.statusApplied,
    voided: i18n.creditNotes.statusVoided,
  };

  async function handleAction(id: string, action: 'issue' | 'apply') {
    setPendingId(id);
    setError(null);
    try {
      if (action === 'issue') await issueCreditNote(orgSlug, id);
      else await applyCreditNote(orgSlug, id);
      router.refresh();
    } catch (e) {
      // 原来这里是 `catch { /* ignore */ }`。签发一张贷项通知单会过账，
      // 于是期间封账、科目没配、金额为零、权限不足都会抛错——而用户看到的
      // 只是「点了没反应」，他会再点一次，然后再一次。必须说出来。
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
      await voidCreditNote(orgSlug, target.id, reason);
      setVoidTarget(null);
      router.refresh();
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

    <table className="transaction-table">
      <caption className="visually-hidden">{i18n.creditNotes.title}</caption>
      <thead>
        <tr>
          <th scope="col">{i18n.creditNotes.number}</th>
          <th scope="col">{i18n.invoices.customer}</th>
          <th scope="col">{i18n.creditNotes.invoice}</th>
          <th scope="col">{i18n.transaction.date}</th>
          <th scope="col" className="numeric">{i18n.transaction.amount}</th>
          <th scope="col">{i18n.invoices.status}</th>
          <th scope="col">{i18n.creditNotes.actions}</th>
        </tr>
      </thead>
      <tbody>
        {creditNotes.map((cn) => (
          <tr key={cn.id} className={cn.status === 'voided' ? 'row-voided' : undefined}>
            {/* 单号链到详情/编辑页。这个链接与
                app/(app)/[orgSlug]/credit-notes/[id]/page.tsx 是同一次改动的
                两半，必须同时到位：本仓库出过「列表链过去但路由不存在」的
                404（见 invoice-list 与 po-list 上的注释），一个通向 404 的
                链接比没有链接更糟——它承诺了一个不存在的地方。 */}
            <td>
              <Link href={`/${orgSlug}/credit-notes/${cn.id}`}>{cn.cnNumber}</Link>
            </td>
            <td>{cn.contactName}</td>
            <td>
              {cn.invoiceId ? (
                <Link href={`/${orgSlug}/invoices/${cn.invoiceId}`}>
                  {cn.invoiceNumber ?? i18n.common.viewDetails}
                </Link>
              ) : (
                i18n.creditNotes.standalone
              )}
            </td>
            <td>{cn.issueDate}</td>
            {/*
              原来是 formatMoney(cn.baseAmountMinor, cn.currency)：拿本位币的
              金额套单据自己的币种。createCreditNote 修过 base_amount_minor 之后
              那一列装的确实是本位币（见 server/actions/credit-notes.ts 的 B2），
              于是一张 1,000 美元、汇率 4.7 的贷项通知单在马币公司的列表上会
              显示成「US$4,700.00」——币种错，而且零小数币种连数字都会差 100 倍。
            */}
            <td className="numeric">
              {formatMoney(cn.baseAmountMinor, baseCurrency, locale)}
            </td>
            <td>
              <span className={STATUS_CLASS[cn.status] ?? 'badge'}>
                {statusLabel[cn.status] ?? cn.status}
              </span>
            </td>
            <td>
              {canWrite && cn.status !== 'voided' ? (
                <span className="action-group">
                  {cn.status === 'draft' ? (
                    <button
                      type="button"
                      className="btn-small"
                      disabled={pendingId === cn.id}
                      onClick={() => handleAction(cn.id, 'issue')}
                    >
                      {i18n.creditNotes.issue}
                    </button>
                  ) : null}
                  {cn.status === 'issued' ? (
                    <button
                      type="button"
                      className="btn-small"
                      disabled={pendingId === cn.id}
                      onClick={() => handleAction(cn.id, 'apply')}
                    >
                      {i18n.creditNotes.apply}
                    </button>
                  ) : null}
                  {/* 已抵扣的也能作废：服务端一直允许，原来只是界面上没有入口，
                      一张抵扣错了的贷项通知单就再也撤不回来。 */}
                  <button
                    type="button"
                    className="btn-small btn-danger"
                    disabled={pendingId === cn.id}
                    onClick={() => {
                      setVoidError(null);
                      setVoidTarget(cn);
                    }}
                  >
                    {i18n.transaction.void}
                  </button>
                </span>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>

    <DocumentVoidDialog
      open={voidTarget !== null}
      title={interpolate(i18n.creditNotes.voidTitle, { number: voidTarget?.cnNumber ?? '' })}
      reasonLabel={i18n.invoices.voidReason}
      reasonHint={i18n.invoices.voidReasonHint}
      requiredMessage={i18n.creditNotes.voidReasonRequired}
      confirmLabel={i18n.creditNotes.voidConfirm}
      cancelLabel={i18n.common.cancel}
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
