'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { CreditNoteListRow } from '@/server/repositories/credit_notes';
import {
  issueCreditNote,
  applyCreditNote,
  voidCreditNote,
} from '@/server/actions/credit_notes';

type Props = {
  orgSlug: string;
  locale: Locale;
  /** 公司本位币。列表里那一栏金额记的是本位币，不是单据自己的币种。 */
  baseCurrency: string;
  i18n: Messages;
  creditNotes: CreditNoteListRow[];
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  issued: 'badge badge-info',
  applied: 'badge badge-success',
  voided: 'badge badge-voided',
};

export function CreditNoteList({ orgSlug, locale, baseCurrency, i18n, creditNotes }: Props) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (creditNotes.length === 0) {
    return <p className="empty-state">{i18n.creditNotes.empty}</p>;
  }

  const statusLabel: Record<string, string> = {
    draft: i18n.creditNotes.statusDraft,
    issued: i18n.creditNotes.statusIssued,
    applied: i18n.creditNotes.statusApplied,
    voided: i18n.creditNotes.statusVoided,
  };

  async function handleAction(id: string, action: 'issue' | 'apply' | 'void') {
    setPendingId(id);
    setError(null);
    try {
      if (action === 'issue') await issueCreditNote(orgSlug, id);
      else if (action === 'apply') await applyCreditNote(orgSlug, id);
      else if (action === 'void') await voidCreditNote(orgSlug, id);
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
            <td>{cn.cnNumber}</td>
            <td>{cn.contactName}</td>
            <td>{cn.invoiceId ? `#${cn.invoiceId.slice(0, 8)}...` : '-'}</td>
            <td>{cn.issueDate}</td>
            {/*
              原来是 formatMoney(cn.baseAmountMinor, cn.currency)：拿本位币的
              金额套单据自己的币种。createCreditNote 修过 base_amount_minor 之后
              那一列装的确实是本位币（见 server/actions/credit_notes.ts 的 B2），
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
              {cn.status === 'draft' ? (
                <span className="action-group">
                  <button
                    type="button"
                    className="btn-small"
                    disabled={pendingId === cn.id}
                    onClick={() => handleAction(cn.id, 'issue')}
                  >
                    {i18n.creditNotes.issue}
                  </button>
                  <button
                    type="button"
                    className="btn-small btn-danger"
                    disabled={pendingId === cn.id}
                    onClick={() => handleAction(cn.id, 'void')}
                  >
                    {i18n.transaction.void}
                  </button>
                </span>
              ) : cn.status === 'issued' ? (
                <span className="action-group">
                  <button
                    type="button"
                    className="btn-small"
                    disabled={pendingId === cn.id}
                    onClick={() => handleAction(cn.id, 'apply')}
                  >
                    {i18n.creditNotes.apply}
                  </button>
                  <button
                    type="button"
                    className="btn-small btn-danger"
                    disabled={pendingId === cn.id}
                    onClick={() => handleAction(cn.id, 'void')}
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
    </>
  );
}
