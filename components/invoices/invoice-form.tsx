'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { createInvoice } from '@/server/actions/invoices';

type Contact = {
  id: string;
  name: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  contacts: Contact[];
  currencies: string[];
};

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
};

export function InvoiceForm({ orgSlug, locale, contacts, currencies }: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const today = new Date().toISOString().slice(0, 10);
  const nextMonth = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const [contactId, setContactId] = useState(contacts[0]?.id ?? '');
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(nextMonth);
  const [currency, setCurrency] = useState('USD');
  const [taxRatePercent, setTaxRatePercent] = useState('0');
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      await createInvoice(orgSlug, {
        contactId,
        issueDate,
        dueDate,
        currency,
        taxRatePercent: taxRatePercent || '0',
        notes: notes || undefined,
        items: items.map((item) => ({
          description: item.description,
          quantity: item.quantity || '1',
          unitPrice: item.unitPrice || '0',
        })),
      });
      router.push(`/${orgSlug}/invoices`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label htmlFor="contactId">{t.invoices.customer}</label>
      <select
        id="contactId"
        value={contactId}
        onChange={(e) => setContactId(e.target.value)}
        required
      >
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <label htmlFor="issueDate">{t.invoices.issueDate}</label>
      <input
        id="issueDate"
        type="date"
        required
        value={issueDate}
        onChange={(e) => setIssueDate(e.target.value)}
      />

      <label htmlFor="dueDate">{t.invoices.dueDate}</label>
      <input
        id="dueDate"
        type="date"
        required
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
      />

      <label htmlFor="currency">{t.transaction.currency}</label>
      <select
        id="currency"
        value={currency}
        onChange={(e) => setCurrency(e.target.value)}
      >
        {currencies.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>

      <label htmlFor="taxRate">{t.invoices.tax}</label>
      <input
        id="taxRate"
        type="number"
        min="0"
        step="0.01"
        value={taxRatePercent}
        onChange={(e) => setTaxRatePercent(e.target.value)}
      />

      <fieldset className="invoice-items">
        <legend>{t.invoices.items}</legend>

        {items.map((item, index) => (
          <div key={index} className="invoice-item-row">
            <input
              placeholder={t.invoices.description}
              value={item.description}
              onChange={(e) => updateItem(index, 'description', e.target.value)}
              required
            />
            <input
              type="number"
              min="0.0001"
              step="0.0001"
              placeholder={t.invoices.quantity}
              value={item.quantity}
              onChange={(e) => updateItem(index, 'quantity', e.target.value)}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder={t.invoices.unitPrice}
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
          {t.invoices.addItem}
        </button>
      </fieldset>

      <label htmlFor="notes">{t.invoices.notes}</label>
      <textarea
        id="notes"
        maxLength={500}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
      />

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" disabled={pending}>
          {pending ? t.common.loading : t.invoices.save}
        </button>
      </div>
    </form>
  );
}
