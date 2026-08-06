'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { PaymentRow } from '@/server/repositories/payments';
import { voidPaymentAction } from '@/server/actions/payments';

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  payments: PaymentRow[];
  contacts: { id: string; name: string }[];
};

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  online: 'Online',
  other: 'Other',
};

export function PaymentList({ orgSlug, locale, i18n, payments, contacts }: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const [typeFilter, setTypeFilter] = useState<'all' | 'received' | 'made'>('all');
  const [contactFilter, setContactFilter] = useState<string>('all');

  const filtered = payments.filter((p) => {
    if (typeFilter !== 'all' && p.type !== typeFilter) return false;
    if (contactFilter !== 'all' && p.contactId !== contactFilter) return false;
    return true;
  });

  async function handleVoid(id: string) {
    if (!confirm(t.common.confirm + '?')) return;
    try {
      await voidPaymentAction(orgSlug, id);
      router.refresh();
    } catch {
      // ignore
    }
  }

  if (payments.length === 0) {
    return (
      <>
        <p className="empty-state">{i18n.payments.empty}</p>
        <Link href={`/${orgSlug}/payments/new`} className="primary-button">
          {i18n.payments.newTitle}
        </Link>
      </>
    );
  }

  return (
    <>
      <Link href={`/${orgSlug}/payments/new`} className="primary-button">
        {i18n.payments.newTitle}
      </Link>

      <div className="filters">
        <label>
          {i18n.payments.type}
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
            <option value="all">{i18n.payments.all}</option>
            <option value="received">{i18n.payments.received}</option>
            <option value="made">{i18n.payments.made}</option>
          </select>
        </label>

        <label>
          {i18n.invoices.customer}
          <select value={contactFilter} onChange={(e) => setContactFilter(e.target.value)}>
            <option value="all">{i18n.payments.all}</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      <table className="transaction-table">
        <caption className="visually-hidden">{i18n.payments.title}</caption>
        <thead>
          <tr>
            <th scope="col">{i18n.transaction.date}</th>
            <th scope="col">{i18n.invoices.customer}</th>
            <th scope="col">{i18n.transaction.kind}</th>
            <th scope="col" className="numeric">{i18n.transaction.amount}</th>
            <th scope="col">{i18n.payments.method}</th>
            <th scope="col">{i18n.payments.reference}</th>
            <th scope="col">{i18n.invoices.status}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id} className={p.voidedAt ? 'row-voided' : undefined}>
              <td>{p.paymentDate}</td>
              <td>{p.contactName ?? '-'}</td>
              <td>
                <span className={p.type === 'received' ? 'badge badge-success' : 'badge badge-danger'}>
                  {p.type === 'received' ? i18n.payments.received : i18n.payments.made}
                </span>
              </td>
              <td className="numeric">
                {formatMoney(p.amountMinor, p.currency)}
              </td>
              <td>{METHOD_LABELS[p.method] ?? p.method}</td>
              <td>{p.reference ?? '-'}</td>
              <td>
                {p.voidedAt ? (
                  <span className="badge badge-voided">{i18n.payments.voided}</span>
                ) : (
                  <span className="badge badge-success">{i18n.invoices.statusPaid}</span>
                )}
              </td>
              <td>
                {!p.voidedAt ? (
                  <button type="button" className="btn-small" onClick={() => handleVoid(p.id)}>
                    {i18n.transaction.void}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
