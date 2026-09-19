'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createCreditNote } from '@/server/actions/credit_notes';
import { todayLocalISO } from '@/lib/date';
import { RateField } from '@/components/transaction/rate-field';

type Contact = { id: string; name: string };
type InvoiceRef = { id: string; invoice_number: string; total_minor: bigint };

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  contacts: Contact[];
  invoices: InvoiceRef[];
  currencies: string[];
  /** 公司本位币。理由见 components/invoices/invoice-form.tsx 上的同名字段。 */
  baseCurrency: string;
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
  baseCurrency,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const today = todayLocalISO();

  const [invoiceId, setInvoiceId] = useState('');
  const [contactId, setContactId] = useState(contacts[0]?.id ?? '');
  const [issueDate, setIssueDate] = useState(today);
  // 缺省本位币，不是 currencies[0]。那个列表的第一项碰巧是 MYR，所以这一处
  // 看着像是对的——但它对的是 SUPPORTED_CURRENCIES 的排序，不是这家公司的
  // 本位币。列表一重排就静默改掉所有新建贷项通知单的币种。
  const [currency, setCurrency] = useState(baseCurrency);
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

  /**
   * 选中发票只记下 id，不去联动客户。
   *
   * 这里原来是一个空的 if 分支加一句「以后再自动填」，读起来像是漏写了
   * 实现——其实是无从实现：invoices 这个下拉列表只带了发票号和总额，
   * 没有带 contact_id，前端根本不知道这张发票开给了谁。要联动得让页面
   * 多查一列，那是这一轮之外的事；在此之前，一个诚实的空动作胜过一段
   * 看起来忘了写的代码。
   */
  function handleInvoiceChange(value: string) {
    setInvoiceId(value);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    // 汇率从 form 里取而不是 state：RateField 只在用户手工改过时才提交
    // exchangeRate，自动查到的那个值刻意不带 name——否则服务端会把一个
    // 缓存汇率记成「用户手工输入」。见 components/transaction/rate-field.tsx。
    const formData = new FormData(e.currentTarget as HTMLFormElement);
    const exchangeRate = formData.get('exchangeRate')
      ? String(formData.get('exchangeRate'))
      : undefined;

    try {
      await createCreditNote(orgSlug, {
        invoiceId: invoiceId || null,
        contactId,
        issueDate,
        currency,
        exchangeRate,
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

      {/*
        汇率栏。此前这张表单上没有，于是 createCreditNote 解析汇率时传的是
        `manualRateEntry: 'unavailable'`，而那条路径的报错让用户「去
        Transactions 页面自己记一笔」——对一张贷项通知单同样是错误建议：
        自己记一笔交易不会冲减任何一张发票的应收。现在能就地填，服务端那个
        常量应当改成 'available'（server/actions/credit_notes.ts 的
        CREDIT_NOTE_MANUAL_RATE_ENTRY）。

        amount 传空串：这张表单没有一个「总金额」输入框，总额是各行单价乘
        数量再加税算出来的。为了给汇率栏画一个「折合多少本位币」的预览而在
        前端用浮点把这些数乘起来，预览值会和服务端整数 half-up 算出来的差
        一两分——本项目的规矩是前端不做金额运算。宁可不显示这行预览。
      */}
      <RateField
        orgSlug={orgSlug}
        currency={currency}
        baseCurrency={baseCurrency}
        occurredOn={issueDate}
        amount=""
        locale={locale}
      />

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
