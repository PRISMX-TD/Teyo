'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createCreditNote } from '@/server/actions/credit_notes';

type Contact = { id: string; name: string };
type InvoiceRef = { id: string; invoice_number: string; total_minor: bigint };

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  contacts: Contact[];
  invoices: InvoiceRef[];
  currencies: string[];
};

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
};

export function CreditNoteForm({
  orgSlug,
  locale,
  i18n,
  contacts,
  invoices,
  currencies,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);

  const [invoiceId, setInvoiceId] = useState('');
  const [contactId, setContactId] = useState(contacts[0]?.id ?? '');
  const [issueDate, setIssueDate] = useState(today);
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LineItem[]>([
    { description: '', quantity: '1', unitPrice: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateItem(index: number, field: keyof LineItem, value: string) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function addItem() {
    setItems((prev) => [...prev, { description: '', quantity: '1', unitPrice: '' }]);
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  function handleInvoiceChange(value: string) {
    setInvoiceId(value);
    if (value) {
      const inv = invoices.find((i) => i.id === value);
      if (inv && contacts.length > 0) {
        // Can't auto-set contact without knowing which contact is linked to the invoice
        // Navigate to the right contact if needed - skip auto-fill for now
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      await createCreditNote(orgSlug, {
        invoiceId: invoiceId || null,
        contactId,
        issueDate,
        currency,
        reason: reason || undefined,
        notes: notes || undefined,
        items: items.map((item) => ({
          description: item.description,
          quantity: item.quantity || '1',
          unitPrice: item.unitPrice || '0',
        })),
      });
      router.push(`/${orgSlug}/credit-notes`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label htmlFor="invoiceId">{i18n.creditNotes.applyToInvoice}</label>
      <select
        id="invoiceId"
        value={invoiceId}
        onChange={(e) => handleInvoiceChange(e.target.value)}
      >
        <option value="">-- {i18n.creditNotes.standalone} --</option>
        {invoices.map((inv) => (
          <option key={inv.id} value={inv.id}>
            {inv.invoice_number}
          </option>
        ))}
      </select>

      <label htmlFor="contactId">{i18n.invoices.customer}</label>
      <select
        id="contactId"
        value={contactId}
        onChange={(e) => setContactId(e.target.value)}
        required
      >
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      <label htmlFor="issueDate">{i18n.transaction.date}</label>
      <input
        id="issueDate"
        type="date"
        required
        value={issueDate}
        onChange={(e) => setIssueDate(e.target.value)}
      />

      <label htmlFor="currency">{i18n.transaction.currency}</label>
      <select
        id="currency"
        value={currency}
        onChange={(e) => setCurrency(e.target.value)}
      >
        {currencies.map((code) => (
          <option key={code} value={code}>{code}</option>
        ))}
      </select>

      <fieldset className="invoice-items">
        <legend>{i18n.invoices.items}</legend>

        {items.map((item, index) => (
          <div key={index} className="invoice-item-row">
            <input
              placeholder={i18n.invoices.description}
              value={item.description}
              onChange={(e) => updateItem(index, 'description', e.target.value)}
              required
            />
            <input
              type="number"
              min="0.0001"
              step="0.0001"
              placeholder={i18n.invoices.quantity}
              value={item.quantity}
              onChange={(e) => updateItem(index, 'quantity', e.target.value)}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder={i18n.invoices.unitPrice}
              value={item.unitPrice}
              onChange={(e) => updateItem(index, 'unitPrice', e.target.value)}
              required
            />
            {items.length > 1 ? (
              <button type="button" onClick={() => removeItem(index)} className="btn-small">
                ×
              </button>
            ) : null}
          </div>
        ))}

        <button type="button" onClick={addItem} className="btn-small">
          {i18n.invoices.addItem}
        </button>
      </fieldset>

      <label htmlFor="reason">{i18n.creditNotes.reason}</label>
      <textarea
        id="reason"
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
      />

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
          {pending ? t.common.loading : i18n.creditNotes.save}
        </button>
      </div>
    </form>
  );
}
