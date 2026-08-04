'use client';

import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { BillListRow } from '@/server/repositories/bills';

type Props = {
  orgSlug: string;
  rows: BillListRow[];
  locale: Locale;
  emptyLabel: string;
};

const STATUS_CLASS: Record<string, string> = {
  draft: 'badge',
  received: 'badge badge-info',
  paid: 'badge badge-success',
  overdue: 'badge badge-danger',
  voided: 'badge badge-voided',
};

export function BillList({ orgSlug, rows, locale, emptyLabel }: Props) {
  const t = getMessages(locale);

  if (rows.length === 0) {
    return <p className="empty-state">{emptyLabel}</p>;
  }

  const statusLabel: Record<string, string> = {
    draft: t.bills.statusDraft,
    received: t.bills.statusReceived,
    paid: t.bills.statusPaid,
    overdue: t.bills.statusOverdue,
    voided: t.bills.statusVoided,
  };

  return (
    <table className="transaction-table">
      <caption className="visually-hidden">{t.bills.title}</caption>
      <thead>
        <tr>
          <th scope="col">{t.bills.number}</th>
          <th scope="col">{t.bills.vendor}</th>
          <th scope="col">{t.bills.issueDate}</th>
          <th scope="col">{t.bills.dueDate}</th>
          <th scope="col">{t.bills.status}</th>
          <th scope="col" className="numeric">{t.bills.total}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className={row.status === 'voided' ? 'row-voided' : undefined}>
            <td>
              <Link href={`/${orgSlug}/bills/${row.id}`}>
                {row.billNumber ?? '\u2014'}
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
