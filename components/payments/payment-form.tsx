'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createPayment } from '@/server/actions/payments';

type Contact = { id: string; name: string };

type OutstandingInvoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  totalMinor: bigint;
  paidMinor: bigint;
  currency: string;
};

type OutstandingBill = {
  id: string;
  billNumber: string;
  vendorName: string;
  totalMinor: bigint;
  paidMinor: bigint;
  currency: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  contacts: Contact[];
  type: 'received' | 'made';
  currencies: string[];
  outstandingInvoices?: OutstandingInvoice[];
  outstandingBills?: OutstandingBill[];
};

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online' },
  { value: 'other', label: 'Other' },
];

export function PaymentForm({
  orgSlug,
  locale,
  i18n,
  contacts,
  type: initialType,
  currencies,
  outstandingInvoices,
  outstandingBills,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);

  const [paymentType, setPaymentType] = useState<'received' | 'made'>(initialType);
  const [contactId, setContactId] = useState(contacts[0]?.id ?? '');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedItems, setSelectedItems] = useState<{ invoiceId?: string; billId?: string; amount: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const unpaidInvoices = useMemo(
    () => (outstandingInvoices ?? []).filter((inv) => (inv.totalMinor - inv.paidMinor) > 0n),
    [outstandingInvoices],
  );

  const unpaidBills = useMemo(
    () => (outstandingBills ?? []).filter((bill) => (bill.totalMinor - bill.paidMinor) > 0n),
    [outstandingBills],
  );

  function toggleItem(item: { id: string; kind: 'invoice' | 'bill'; remainingMinor: bigint }) {
    setSelectedItems((prev) => {
      const exists = prev.find((si) =>
        item.kind === 'invoice' ? si.invoiceId === item.id : si.billId === item.id,
      );
      if (exists) {
        return prev.filter((si) =>
          item.kind === 'invoice' ? si.invoiceId !== item.id : si.billId !== item.id,
        );
      }
      const newItem = item.kind === 'invoice'
        ? { invoiceId: item.id, amount: '' }
        : { billId: item.id, amount: '' };
      return [...prev, newItem];
    });
  }

  function updateItemAmount(index: number, value: string) {
    setSelectedItems((prev) => prev.map((item, i) => (i === index ? { ...item, amount: value } : item)));
  }

  const totalItemAmount = useMemo(() => {
    return selectedItems.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
  }, [selectedItems]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      const items = selectedItems.map((item) => ({
        invoiceId: item.invoiceId ?? null,
        billId: item.billId ?? null,
        amount: item.amount || '0',
      }));

      await createPayment(orgSlug, {
        contactId,
        type: paymentType,
        amount: amount || totalItemAmount.toFixed(2),
        currency,
        paymentDate: date,
        method: method as 'cash' | 'bank_transfer' | 'cheque' | 'online' | 'other',
        reference: reference || undefined,
        notes: notes || undefined,
        items: items.length > 0 ? items : [{ invoiceId: null, billId: null, amount: amount || '0' }],
      });
      router.push(`/${orgSlug}/payments`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label>{i18n.payments.type}</label>
      <div className="radio-group">
        <label>
          <input
            type="radio"
            name="paymentType"
            value="received"
            checked={paymentType === 'received'}
            onChange={() => setPaymentType('received')}
          />
          {i18n.payments.received}
        </label>
        <label>
          <input
            type="radio"
            name="paymentType"
            value="made"
            checked={paymentType === 'made'}
            onChange={() => setPaymentType('made')}
          />
          {i18n.payments.made}
        </label>
      </div>

      <label htmlFor="contactId">{i18n.invoices.customer}</label>
      <select
        id="contactId"
        value={contactId}
        onChange={(e) => { setContactId(e.target.value); setSelectedItems([]); }}
        required
      >
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      <label htmlFor="date">{i18n.transaction.date}</label>
      <input
        id="date"
        type="date"
        required
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />

      <label htmlFor="amount">{i18n.transaction.amount}</label>
      <input
        id="amount"
        type="number"
        min="0"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder={totalItemAmount > 0 ? totalItemAmount.toFixed(2) : ''}
      />

      <label htmlFor="currency">{i18n.transaction.currency}</label>
      <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
        {currencies.map((code) => (
          <option key={code} value={code}>{code}</option>
        ))}
      </select>

      <label htmlFor="method">{i18n.payments.method}</label>
      <select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
        {METHODS.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>

      <label htmlFor="reference">{i18n.payments.reference}</label>
      <input
        id="reference"
        type="text"
        maxLength={200}
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />

      {paymentType === 'received' && unpaidInvoices.length > 0 ? (
        <fieldset>
          <legend>{i18n.payments.applyToInvoices}</legend>
          {unpaidInvoices.map((inv) => {
            const remaining = Number(inv.totalMinor - inv.paidMinor) / 100;
            const isSelected = selectedItems.some((si) => si.invoiceId === inv.id);
            return (
              <label key={inv.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleItem({ id: inv.id, kind: 'invoice', remainingMinor: inv.totalMinor - inv.paidMinor })}
                />
                <span>{inv.invoiceNumber} - {inv.customerName} ({remaining.toFixed(2)} {inv.currency})</span>
                {isSelected ? (
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder={remaining.toFixed(2)}
                    value={selectedItems.find((si) => si.invoiceId === inv.id)?.amount ?? ''}
                    onChange={(e) => {
                      const idx = selectedItems.findIndex((si) => si.invoiceId === inv.id);
                      if (idx >= 0) updateItemAmount(idx, e.target.value);
                    }}
                  />
                ) : null}
              </label>
            );
          })}
        </fieldset>
      ) : null}

      {paymentType === 'made' && unpaidBills.length > 0 ? (
        <fieldset>
          <legend>{i18n.payments.applyToBills}</legend>
          {unpaidBills.map((bill) => {
            const remaining = Number(bill.totalMinor - bill.paidMinor) / 100;
            const isSelected = selectedItems.some((si) => si.billId === bill.id);
            return (
              <label key={bill.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleItem({ id: bill.id, kind: 'bill', remainingMinor: bill.totalMinor - bill.paidMinor })}
                />
                <span>{bill.billNumber} - {bill.vendorName} ({remaining.toFixed(2)} {bill.currency})</span>
                {isSelected ? (
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder={remaining.toFixed(2)}
                    value={selectedItems.find((si) => si.billId === bill.id)?.amount ?? ''}
                    onChange={(e) => {
                      const idx = selectedItems.findIndex((si) => si.billId === bill.id);
                      if (idx >= 0) updateItemAmount(idx, e.target.value);
                    }}
                  />
                ) : null}
              </label>
            );
          })}
        </fieldset>
      ) : null}

      <label htmlFor="notes">{i18n.invoices.notes}</label>
      <textarea
        id="notes"
        maxLength={2000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
      />

      {error ? (
        <p role="alert" className="form-error">{error}</p>
      ) : null}

      <div className="form-actions">
        <button type="submit" disabled={pending}>
          {pending ? t.common.loading : i18n.payments.save}
        </button>
      </div>
    </form>
  );
}
