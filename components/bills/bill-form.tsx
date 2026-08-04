'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createBill } from '@/server/actions/bills';

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
  amount: string;
};

export function BillForm({ orgSlug, locale, contacts, currencies }: Props) {
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
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LineItem[]>([
    { description: '', amount: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateItem(index: number, field: keyof LineItem, value: string) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function addItem() {
    setItems((prev) => [...prev, { description: '', amount: '' }]);
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      await createBill(orgSlug, {
        contactId,
        issueDate,
        dueDate,
        currency,
        notes: notes || undefined,
        items: items.map((item) => ({
          description: item.description,
          amount: item.amount || '0',
        })),
      });
      router.push(`/${orgSlug}/bills`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label htmlFor="contactId">{t.bills.vendor}</label>
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

      <label htmlFor="issueDate">{t.bills.issueDate}</label>
      <input
        id="issueDate"
        type="date"
        required
        value={issueDate}
        onChange={(e) => setIssueDate(e.target.value)}
      />

      <label htmlFor="dueDate">{t.bills.dueDate}</label>
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

      <fieldset className="invoice-items">
        <legend>{t.bills.items}</legend>

        {items.map((item, index) => (
          <div key={index} className="invoice-item-row">
            <input
              placeholder={t.bills.description}
              value={item.description}
              onChange={(e) => updateItem(index, 'description', e.target.value)}
              required
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder={t.bills.amount}
              value={item.amount}
              onChange={(e) => updateItem(index, 'amount', e.target.value)}
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
          {t.bills.addItem}
        </button>
      </fieldset>

      <label htmlFor="notes">{t.bills.notes}</label>
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
          {pending ? t.common.loading : t.bills.save}
        </button>
      </div>
    </form>
  );
}
