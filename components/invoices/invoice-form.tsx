'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createInvoice, issueInvoice, updateInvoice } from '@/server/actions/invoices';
import { addMonthsLocalISO, todayLocalISO } from '@/lib/date';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import type { InvoiceDetail } from '@/server/repositories/invoices';
import { DocumentLifecycle } from '@/components/invoices/document-lifecycle';
import { MAX_INVOICE_REFERENCE_LENGTH } from '@/lib/invoice-options';
import { Plus, X } from '@/components/ui/icons';
import { trimQuantity } from '@/components/invoices/line-items';
import { useHeaderIssue } from '@/components/invoices/header-issue';

type Contact = {
  id: string;
  name: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  contacts: Contact[];
  currencies: string[];
  /**
   * 公司本位币。此前这个值根本没传下来，表单硬写 `useState('USD')`。
   *
   * 服务端已经改成「省略 currency 即取本位币」（见 resolveDocumentCurrency），
   * 但表单每次都显式传 'USD'，那条缺省路径永远走不到。对一家本位币是 MYR
   * 的马来西亚商户，结果是每张发票都被记成美元：金额不变、币种变了，
   * 折成本位币之后整张发票翻了四倍多，而界面上只有一个不起眼的下拉框写着 USD。
   */
  baseCurrency: string;
  /** 有值即编辑模式。null/undefined 是新建。 */
  invoice?: InvoiceDetail | null;
  /**
   * 只读：这个角色改不了（updateInvoice 要 transaction:edit:any），或者
   * 发票已经收讫。画一张填得动却必然保存失败的表单，等于让用户白填一遍。
   */
  readOnly?: boolean;
  /** 已过到期日且没收齐（页面按公司时区判的）。只影响状态条下那句提示。 */
  overdue?: boolean;
};

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
};

/**
 * 基点 → 百分数字符串。600 bps -> '6.00'。
 *
 * 全程整数：600 / 100 在浮点下是 6，但 625 / 100 是 6.25 而 8.7 这类值
 * 会出现 6.249999999999999 那样的尾巴，再被 parseTaxRateBps 解析回去就
 * 可能差一个基点。整除加取余没有这个问题。
 */
function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

/** 已有发票的明细转回表单用的十进制字符串。 */
function itemsOf(invoice: InvoiceDetail): LineItem[] {
  const exponent = currencyExponent(invoice.currency);
  if (invoice.items.length === 0) {
    return [{ description: '', quantity: '1', unitPrice: '' }];
  }
  return invoice.items.map((item) => ({
    description: item.description,
    quantity: trimQuantity(item.quantity),
    unitPrice: formatMinorToDecimal(item.unitPriceMinor, exponent),
  }));
}

export function InvoiceForm({
  orgSlug,
  locale,
  contacts,
  currencies,
  baseCurrency,
  invoice = null,
  readOnly = false,
  overdue = false,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const isEdit = invoice !== null;
  const status: string = invoice?.status ?? 'draft';
  const isVoided = invoice !== null && (status === 'voided' || invoice.voidedAt !== null);
  const isPosted = invoice?.transactionId != null;

  const [contactId, setContactId] = useState(invoice?.contactId ?? contacts[0]?.id ?? '');
  const [issueDate, setIssueDate] = useState(invoice?.issueDate ?? todayLocalISO());
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? addMonthsLocalISO(1));
  // 缺省是本位币，不是 'USD'。编辑时当然用这张发票自己的币种。
  const [currency, setCurrency] = useState(invoice?.currency ?? baseCurrency);
  const [taxRatePercent, setTaxRatePercent] = useState(
    invoice ? bpsToPercent(invoice.taxRateBps) : '0',
  );
  const [notes, setNotes] = useState(invoice?.notes ?? '');
  const [reference, setReference] = useState(invoice?.reference ?? '');
  const [items, setItems] = useState<LineItem[]>(
    invoice ? itemsOf(invoice) : [{ description: '', quantity: '1', unitPrice: '' }],
  );
  // 新建时默认存草稿：金额、客户、明细通常还要改几轮，草稿不进总账。
  // 想一步到位的勾上它，createInvoice 会在同一个事务里过账。
  const [issueNow, setIssueNow] = useState(false);
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

  // 开具成功后的 router.refresh() 要等新页面到了才算完：在那之前页头仍是
  // 「开具」，再点一下会把刚开出的发票重存一遍（updateInvoice 接受已过账的
  // 发票，会重新过账）然后才报「已开具」。页头按钮的忙碌状态把刷新也算上。
  const [refreshing, startRefresh] = useTransition();

  const formRef = useRef<HTMLFormElement>(null);
  // 详情页页头的「开具」：先过一遍与保存按钮相同的浏览器校验，再存、再开具。
  const header = useHeaderIssue(() => {
    if (pending || refreshing || !formRef.current?.reportValidity()) return;
    void save(true);
  });

  const setHeaderPending = header?.setPending;
  useEffect(() => {
    setHeaderPending?.(pending || refreshing);
  }, [setHeaderPending, pending, refreshing]);
  useEffect(() => () => setHeaderPending?.(false), [setHeaderPending]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save(false);
  }

  async function save(thenIssue: boolean) {
    setPending(true);
    setError(null);
    header?.setError(null);

    const payload = {
      contactId,
      issueDate,
      dueDate,
      currency,
      taxRatePercent: taxRatePercent || '0',
      notes: notes || undefined,
      reference: reference || undefined,
      items: items.map((item) => ({
        description: item.description,
        quantity: item.quantity || '1',
        unitPrice: item.unitPrice || '0',
      })),
    };

    try {
      if (isEdit && invoice) {
        // 只读（能开具、却没有 edit:any 的记账员）时表单改不动，没有可存的。
        if (!readOnly) await updateInvoice(orgSlug, invoice.id, payload);
        if (thenIssue) {
          await issueInvoice(orgSlug, invoice.id);
          // 留在这一页：开具之后，记录收款的入口就在这页的页头上。
          startRefresh(() => router.refresh());
          return;
        }
      } else {
        await createInvoice(orgSlug, { ...payload, issue: issueNow });
      }
      // 带上 ?saved=1，让列表页去说「已保存」。在这张表单上先弹一句再跳走
      // 是没有意义的——用户的眼睛还没到那句话，页面已经换了。
      router.push(`/${orgSlug}/invoices?saved=1`);
      // push 之后再 refresh：过账改了总账，列表页、流水页与首页的数字都变了，
      // 而那几个页面可能还在路由缓存里。
      router.refresh();
    } catch (err) {
      const message = (err as Error).message;
      if (thenIssue && header) header.setError(message);
      else setError(message);
    } finally {
      setPending(false);
    }
  }

  const lifecycle = isEdit ? (
    <DocumentLifecycle
      caption={t.invoices.lifecycle}
      steps={[
        { value: 'draft', label: t.invoices.statusDraft },
        { value: 'sent', label: t.invoices.statusSent },
        { value: 'partially_paid', label: t.invoices.statusPartiallyPaid },
        { value: 'paid', label: t.invoices.statusPaid },
      ]}
      // overdue 不是这条线上的一步，而是 sent 迟到了。把它画成第五步会
      // 让人以为发票「走到了逾期」再走去已付，而实际上它只是 sent 的一种。
      current={status === 'overdue' ? 'sent' : status}
      voided={isVoided}
      voidedLabel={t.invoices.statusVoided}
      notice={
        isVoided
          ? t.invoices.voidedNotice
          : status === 'paid'
            ? t.invoices.paidNotice
            : overdue
              ? t.invoices.overdueNotice
              : isPosted
                ? t.invoices.postedNotice
                : t.invoices.draftNotice
      }
    />
  ) : null;

  // 已作废的发票在服务端一律拒绝编辑（updateInvoice 第一件事就是查这个）。
  // 画一张能填的表单再让保存失败，是在浪费用户重录一遍的时间。
  if (isVoided) {
    return <>{lifecycle}</>;
  }

  return (
    <>
      {lifecycle}

      <form ref={formRef} onSubmit={handleSubmit} className="transaction-form">
        {/* display: contents 让这一层不参与 .transaction-form 的排版，
            只负责把 disabled 传给里面每一个控件。 */}
        <fieldset disabled={readOnly} style={{ display: 'contents' }}>
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

        {/* 紧跟在客户后面：PO 号是那个客户给的，填的人手里拿着的正是那张采购单。 */}
        <label htmlFor="reference">{t.invoices.reference}</label>
        <input
          id="reference"
          maxLength={MAX_INVOICE_REFERENCE_LENGTH}
          aria-describedby="referenceHint"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <p id="referenceHint" className="field-hint">
          {t.invoices.referenceHint}
        </p>

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
        <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>

        {/* 填的是百分比，不是税额：原来标签写「税额」，有人照着填 40
            （想的是 RM 40 的税），存下来就成了 40% 的税率。 */}
        <label htmlFor="taxRate">{t.invoices.taxRate}</label>
        <div className="input-suffix">
          <input
            id="taxRate"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={taxRatePercent}
            onChange={(e) => setTaxRatePercent(e.target.value)}
          />
          <span aria-hidden="true">%</span>
        </div>

        <fieldset className="invoice-items">
          <legend>{t.invoices.items}</legend>

          {/* 列名。此前每一行只靠 placeholder 说明这一栏是什么——一开始
              打字它就消失，第二行往后用户只能靠列宽去猜哪个是数量哪个是
              单价。表头写一次，所有行共用。aria-hidden：每个输入框自己
              已经带了 aria-label，读屏器不必再听一遍列名。 */}
          <div className="invoice-item-head" aria-hidden="true">
            <span>{t.invoices.description}</span>
            <span>{t.invoices.quantity}</span>
            <span>{t.invoices.unitPrice}</span>
          </div>

          {items.map((item, index) => (
            <div key={index} className="invoice-item-row">
              <input
                placeholder={t.invoices.description} aria-label={t.invoices.description}
                value={item.description}
                onChange={(e) => updateItem(index, 'description', e.target.value)}
                required
              />
              {/* 数量、单价各包一层 label：手机上表头收起，标签露出来。 */}
              <label className="item-field">
                <span className="item-field__label">{t.invoices.quantity}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.0001"
                  step="0.0001"
                  placeholder={t.invoices.quantity} aria-label={t.invoices.quantity}
                  value={item.quantity}
                  onChange={(e) => updateItem(index, 'quantity', e.target.value)}
                />
              </label>
              <label className="item-field">
                <span className="item-field__label">{t.invoices.unitPrice}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder={t.invoices.unitPrice} aria-label={t.invoices.unitPrice}
                  value={item.unitPrice}
                  onChange={(e) => updateItem(index, 'unitPrice', e.target.value)}
                  required
                />
              </label>
              {items.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeItem(index)}
                  className="btn-small"
                  // 图标按钮必须有名字：屏幕阅读器念一个 '×' 是念不出
                  // 「删掉第几行」的。
                  aria-label={`${t.common.delete} ${t.invoices.items} ${index + 1}`}
                >
                  <X size={16} weight="bold" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ))}

          <button type="button" onClick={addItem} className="add-button">
            <Plus size={16} weight="bold" aria-hidden="true" />
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

        {!isEdit ? (
          <label className="doc-toggle" htmlFor="issueNow">
            <input
              id="issueNow"
              type="checkbox"
              checked={issueNow}
              onChange={(e) => setIssueNow(e.target.checked)}
            />
            <span>
              {t.invoices.issueNow}
              <span className="field-hint">{t.invoices.issueNowHint}</span>
            </span>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}

        </fieldset>

        {readOnly ? null : (
          <div className="form-actions">
            <button type="submit" disabled={pending || refreshing}>
              {pending ? t.common.loading : isEdit ? t.invoices.saveChanges : t.invoices.save}
            </button>
          </div>
        )}
      </form>
    </>
  );
}
