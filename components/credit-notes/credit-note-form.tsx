'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createCreditNote, updateCreditNoteAction } from '@/server/actions/credit_notes';
import { todayLocalISO } from '@/lib/date';
import { RateField } from '@/components/transaction/rate-field';

type Contact = { id: string; name: string };
type InvoiceRef = { id: string; invoice_number: string; total_minor: bigint };

/**
 * 编辑模式下这张表单需要的那张单据，已经摊平成字符串。
 *
 * 不直接收 CreditNoteDetail：那上面的金额与汇率是 bigint（最小货币单位、
 * 放大 10^8 的定标整数），还原成人看得懂的十进制要走 formatMinorToDecimal /
 * formatScaledRate。那两步放在页面（服务端）做一次，比让这个客户端组件
 * 自己再写一遍换算安全——本仓库里「第二份换算实现」正是反复出问题的那一类。
 */
export type CreditNoteEditable = {
  id: string;
  cnNumber: string;
  invoiceId: string | null;
  contactId: string;
  issueDate: string;
  currency: string;
  /** 十进制字符串，由 formatScaledRate 从 exchange_rate 那一列还原。 */
  exchangeRate: string;
  reason: string | null;
  notes: string | null;
  items: LineItem[];
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  contacts: Contact[];
  invoices: InvoiceRef[];
  currencies: string[];
  /** 公司本位币。理由见 components/invoices/invoice-form.tsx 上的同名字段。 */
  baseCurrency: string;
  /**
   * 有值即编辑模式。只有草稿才会走到这里——已签发的单据服务端直接拒绝
   * （server/actions/credit_notes.ts 的 updateCreditNoteAction），页面负责
   * 在那之前就不渲染这张表单。
   */
  creditNote?: CreditNoteEditable | null;
};

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  /**
   * 这一行挂的税率 id，原样带进带出。
   *
   * 这张表单上没有税率选择框（新建时每一行都是不含税的），但
   * updateCreditNoteAction 收到 items 就会把明细整批删掉重写。编辑时不把
   * 已有的 tax_rate_id 带回去，一张含 6% SST 的贷项通知单保存一次税就没了
   * ——金额少冲一截，而且事后从数据里看不出来是哪一步弄丢的。
   */
  taxRateId: string | null;
};

export function CreditNoteForm({
  orgSlug,
  locale,
  i18n,
  contacts,
  invoices,
  currencies,
  baseCurrency,
  creditNote = null,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const today = todayLocalISO();
  const isEdit = creditNote !== null;

  const [invoiceId, setInvoiceId] = useState(creditNote?.invoiceId ?? '');
  const [contactId, setContactId] = useState(creditNote?.contactId ?? contacts[0]?.id ?? '');
  const [issueDate, setIssueDate] = useState(creditNote?.issueDate ?? today);
  // 缺省本位币，不是 currencies[0]。那个列表的第一项碰巧是 MYR，所以这一处
  // 看着像是对的——但它对的是 SUPPORTED_CURRENCIES 的排序，不是这家公司的
  // 本位币。列表一重排就静默改掉所有新建贷项通知单的币种。
  const [currency, setCurrency] = useState(creditNote?.currency ?? baseCurrency);
  const [reason, setReason] = useState(creditNote?.reason ?? '');
  const [notes, setNotes] = useState(creditNote?.notes ?? '');
  const [items, setItems] = useState<LineItem[]>(
    creditNote && creditNote.items.length > 0
      ? creditNote.items
      : [{ description: '', quantity: '1', unitPrice: '', taxRateId: null }],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateItem(index: number, field: 'description' | 'quantity' | 'unitPrice', value: string) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function addItem() {
    setItems((prev) => [
      ...prev,
      { description: '', quantity: '1', unitPrice: '', taxRateId: null },
    ]);
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

    const payloadItems = items.map((item) => ({
      description: item.description,
      quantity: item.quantity || '1',
      unitPrice: item.unitPrice || '0',
      taxRateId: item.taxRateId,
    }));

    try {
      if (isEdit && creditNote) {
        await updateCreditNoteAction(orgSlug, creditNote.id, {
          invoiceId: invoiceId || null,
          contactId,
          issueDate,
          currency,
          exchangeRate,
          // 清空文本框传 null（「这张单不再写原因」），不是 undefined
          // （「这一次不动原因」）。两者在服务端是不同的意思。
          reason: reason || null,
          notes: notes || null,
          // 明细每次都整批带过去：换币种时服务端本来就要求重报明细
          // （最小单位整数的含义由币种决定），少传一次就是一句报错。
          items: payloadItems,
        });
      } else {
        await createCreditNote(orgSlug, {
          invoiceId: invoiceId || null,
          contactId,
          issueDate,
          currency,
          exchangeRate,
          reason: reason || undefined,
          notes: notes || undefined,
          items: payloadItems,
        });
      }
      router.push(`/${orgSlug}/credit-notes`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      {/* 草稿说明。发票和账单表单都告诉了用户「存下来还没进账」，只有贷项
          通知单没有——而这里的落差最伤人：用户以为已经把钱从客户欠款里
          减掉了，实际上那张发票的应收一分没动。
          新建出来的一定是草稿，所以这里不像另外两个表单那样套
          DocumentLifecycle 去画状态机——只有一个状态的状态条说不出任何东西，
          只借它那句提示的排版与 role="status"。
          编辑模式下不画这一句：详情页已经用 DocumentLifecycle 画了完整的
          状态机，同一句话说两遍只会让人以为是两条不同的提示。 */}
      {!isEdit ? (
        <p className="doc-lifecycle__notice" role="status">
          {i18n.creditNotes.draftNotice}
        </p>
      ) : null}

      <label htmlFor="invoiceId">{i18n.creditNotes.applyToInvoice}</label>
      <select
        id="invoiceId"
        value={invoiceId}
        onChange={(e) => handleInvoiceChange(e.target.value)}
      >
        <option value="">{i18n.creditNotes.standalone}</option>
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
        // 编辑时带上这张单当初记下的汇率，并且当作「手工」提交回去。
        //
        // 不带的话：这张表单每次保存都会重传 items，服务端因此进入重算分支
        // 去查缓存汇率，于是「打开一张上个月的外币贷项通知单改一句备注」会
        // 把它的汇率悄悄换成今天的，本位币金额跟着变，而屏幕上什么提示都
        // 没有。标成 manual 不是谎报来源：这张单的汇率本来就以单据上记着的
        // 那个为准，issueCreditNote 过账时用的也是它（见那里关于 rate_source
        // 的注释）。
        initialRate={isEdit ? creditNote?.exchangeRate : undefined}
        initialSource={isEdit ? 'manual' : undefined}
      />

      <fieldset className="invoice-items">
        <legend>{i18n.invoices.items}</legend>

        {/* 列名。此前每一行只靠 placeholder 说明这一栏是什么——一开始
            打字它就消失，第二行往后用户只能靠列宽去猜哪个是数量哪个是
            单价。表头写一次，所有行共用。aria-hidden：每个输入框自己
            已经带了 aria-label，读屏器不必再听一遍列名。 */}
        <div className="invoice-item-head" aria-hidden="true">
          <span>{i18n.invoices.description}</span>
          <span>{i18n.invoices.quantity}</span>
          <span>{i18n.invoices.unitPrice}</span>
        </div>

        {items.map((item, index) => (
          <div key={index} className="invoice-item-row">
            <input
              placeholder={i18n.invoices.description} aria-label={i18n.invoices.description}
              value={item.description}
              onChange={(e) => updateItem(index, 'description', e.target.value)}
              required
            />
            <input
              type="number"
              min="0.0001"
              step="0.0001"
              placeholder={i18n.invoices.quantity} aria-label={i18n.invoices.quantity}
              value={item.quantity}
              onChange={(e) => updateItem(index, 'quantity', e.target.value)}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder={i18n.invoices.unitPrice} aria-label={i18n.invoices.unitPrice}
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
          {pending
            ? t.common.loading
            : isEdit
              ? i18n.creditNotes.saveChanges
              : i18n.creditNotes.save}
        </button>
      </div>
    </form>
  );
}
