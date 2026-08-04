'use client';

import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { InvoiceListRow } from '@/server/repositories/invoices';

type Props = {
  orgSlug: string;
  rows: InvoiceListRow[];
  locale: Locale;
  emptyLabel: string;
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  sent: 'badge badge-info',
  paid: 'badge badge-success',
  overdue: 'badge badge-danger',
  voided: 'badge badge-voided',
};

export function InvoiceList({ orgSlug, rows, locale, emptyLabel }: Props) {
  const t = getMessages(locale);

  if (rows.length === 0) {
    return <p className="empty-state">{emptyLabel}</p>;
  }

  const statusLabel: Record<string, string> = {
    draft: t.invoices.statusDraft,
    sent: t.invoices.statusSent,
    paid: t.invoices.statusPaid,
    overdue: t.invoices.statusOverdue,
    voided: t.invoices.statusVoided,
  };

  return (
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
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className={row.status === 'voided' ? 'row-voided' : undefined}>
            <td>
              <Link href={`/${orgSlug}/invoices/${row.id}`}>
                {row.invoiceNumber}
              </Link>
            </td>
            <td>{row.contactName}</td>
            <td>{row.issueDate}</td>
            <td>{row.dueDate}</td>
            <td>
              <span className={STATUS_CLASS[row.status] ?? 'badge'}>
                {statusLabel[row.status] ?? row.status}
              </span>
            </td>
            <td className="numeric money-out">
              {formatMoney(row.totalMinor, row.currency)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
