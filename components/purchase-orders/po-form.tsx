'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createPurchaseOrder } from '@/server/actions/purchase_orders';

type Vendor = {
  id: string;
  name: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  vendors: Vendor[];
  currencies: string[];
};

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
};

export function PoForm({ orgSlug, locale, vendors, currencies }: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const today = new Date().toISOString().slice(0, 10);

  const [contactId, setContactId] = useState(vendors[0]?.id ?? '');
  const [issueDate, setIssueDate] = useState(today);
  const [expectedDate, setExpectedDate] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<LineItem[]>([
    { description: '', quantity: '1', unitPrice: '', taxRate: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateItem(index: number, field: keyof LineItem, value: string) {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    );
  }

  function addItem() {
    setItems((prev) => [...prev, { description: '', quantity: '1', unitPrice: '', taxRate: '' }]);
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  const TAX_RATES = ['0', '6', '10', '12'];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      await createPurchaseOrder(orgSlug, {
        contactId,
        issueDate,
        expectedDate: expectedDate || undefined,
        currency,
        notes: notes || undefined,
        items: items.map((item) => {
          const qty = parseFloat(item.quantity) || 0;
          const unitPrice = Math.round((parseFloat(item.unitPrice) || 0) * 100);
          const taxRate = parseFloat(item.taxRate) || 0;
          const amount = unitPrice * Math.round(qty);
          return {
            description: item.description,
            quantity: qty,
            unitPriceMinor: String(unitPrice),
            amountMinor: String(amount),
            taxRateId: taxRate > 0 ? undefined : undefined, // placeholder for tax rate
          };
        }),
      });
      router.push(`/${orgSlug}/purchase-orders`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label htmlFor="contactId">{t.purchaseOrders.vendor}</label>
      <select
        id="contactId"
        value={contactId}
        onChange={(e) => setContactId(e.target.value)}
        required
      >
        {vendors.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>

      <label htmlFor="issueDate">{t.purchaseOrders.issueDate}</label>
      <input
        id="issueDate"
        type="date"
        required
        value={issueDate}
        onChange={(e) => setIssueDate(e.target.value)}
      />

      <label htmlFor="expectedDate">{t.purchaseOrders.expectedDate}</label>
      <input
        id="expectedDate"
        type="date"
        value={expectedDate}
        onChange={(e) => setExpectedDate(e.target.value)}
      />

      <label htmlFor="currency">{t.purchaseOrders.currency}</label>
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
        <legend>{t.purchaseOrders.items}</legend>

        {items.map((item, index) => (
          <div key={index} className="invoice-item-row">
            <input
              placeholder={t.purchaseOrders.description}
              value={item.description}
              onChange={(e) => updateItem(index, 'description', e.target.value)}
              required
            />
            <input
              type="number"
              min="0.0001"
              step="0.0001"
              placeholder={t.purchaseOrders.quantity}
              value={item.quantity}
              onChange={(e) => updateItem(index, 'quantity', e.target.value)}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder={t.purchaseOrders.unitPrice}
              value={item.unitPrice}
              onChange={(e) => updateItem(index, 'unitPrice', e.target.value)}
              required
            />
            <select
              value={item.taxRate}
              onChange={(e) => updateItem(index, 'taxRate', e.target.value)}
            >
              <option value="">{t.purchaseOrders.tax}</option>
              {TAX_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}%
                </option>
              ))}
            </select>
            {items.length > 1 ? (
              <button type="button" onClick={() => removeItem(index)} className="btn-small">
                ×
              </button>
            ) : null}
          </div>
        ))}

        <button type="button" onClick={addItem} className="btn-small">
          {t.purchaseOrders.addItem}
        </button>
      </fieldset>

      <label htmlFor="notes">{t.purchaseOrders.notes}</label>
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
          {pending ? t.common.loading : t.purchaseOrders.save}
        </button>
      </div>
    </form>
  );
}
