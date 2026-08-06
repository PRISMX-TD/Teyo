'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
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
  i18n: Messages;
  creditNotes: CreditNoteListRow[];
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  issued: 'badge badge-info',
  applied: 'badge badge-success',
  voided: 'badge badge-voided',
};

export function CreditNoteList({ orgSlug, locale, i18n, creditNotes }: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);

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
    try {
      if (action === 'issue') await issueCreditNote(orgSlug, id);
      else if (action === 'apply') await applyCreditNote(orgSlug, id);
      else if (action === 'void') await voidCreditNote(orgSlug, id);
      router.refresh();
    } catch {
      // ignore
    } finally {
      setPendingId(null);
    }
  }

  return (
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
          <th scope="col"></th>
        </tr>
      </thead>
      <tbody>
        {creditNotes.map((cn) => (
          <tr key={cn.id} className={cn.status === 'voided' ? 'row-voided' : undefined}>
            <td>{cn.cnNumber}</td>
            <td>{cn.contactName}</td>
            <td>{cn.invoiceId ? `#${cn.invoiceId.slice(0, 8)}...` : '-'}</td>
            <td>{cn.issueDate}</td>
            <td className="numeric">
              {formatMoney(cn.baseAmountMinor, cn.currency)}
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
  );
}
