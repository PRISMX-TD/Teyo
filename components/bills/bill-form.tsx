'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createBill, updateBill } from '@/server/actions/bills';
import { addMonthsLocalISO, todayLocalISO } from '@/lib/date';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import type { BillDetail } from '@/server/repositories/bills';
import { DocumentLifecycle } from '@/components/invoices/document-lifecycle';

type Contact = {
  id: string;
  name: string;
};

/** 页面从 server/repositories/tax.ts 的 listTaxRates 查出来，按当前语言取好名字再传进来。 */
export type BillTaxRateOption = {
  id: string;
  name: string;
  rateBps: number;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  contacts: Contact[];
  currencies: string[];
  /** 公司本位币。理由见 components/invoices/invoice-form.tsx 上的同名字段。 */
  baseCurrency: string;
  taxRates: BillTaxRateOption[];
  /** 有值即编辑模式。 */
  bill?: BillDetail | null;
};

type LineItem = {
  description: string;
  amount: string;
};

/** 基点 → 百分数字符串，整数运算。理由见 invoice-form.tsx 的同名函数。 */
function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

function itemsOf(bill: BillDetail): LineItem[] {
  const exponent = currencyExponent(bill.currency);
  if (bill.items.length === 0) return [{ description: '', amount: '' }];
  return bill.items.map((item) => ({
    description: item.description,
    amount: formatMinorToDecimal(item.amountMinor, exponent),
  }));
}

export function BillForm({
  orgSlug,
  locale,
  contacts,
  currencies,
  baseCurrency,
  taxRates,
  bill = null,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const isEdit = bill !== null;
  const status: string = bill?.status ?? 'draft';
  const isVoided = bill !== null && (status === 'voided' || bill.voidedAt !== null);
  const isPosted = bill?.transactionId != null;

  const [contactId, setContactId] = useState(bill?.contactId ?? contacts[0]?.id ?? '');
  const [issueDate, setIssueDate] = useState(bill?.issueDate ?? todayLocalISO());
  const [dueDate, setDueDate] = useState(bill?.dueDate ?? addMonthsLocalISO(1));
  const [currency, setCurrency] = useState(bill?.currency ?? baseCurrency);
  const [notes, setNotes] = useState(bill?.notes ?? '');
  const [items, setItems] = useState<LineItem[]>(
    bill ? itemsOf(bill) : [{ description: '', amount: '' }],
  );
  /**
   * 选中的税率。
   *
   * 0021 之前 bills 上只有 total_minor 一列，一张含 6% SST 的供应商账单
   * 没有地方放税额——它只能被并进费用科目，于是 repositories/tax.ts 那句
   * `0::bigint as tax_minor`（进项税恒为零）并不是查询写错了，而是数据模型
   * 里根本没有那个数。0021 补上了 subtotal_minor / tax_rate_bps / tax_minor，
   * 这个下拉框是它们在界面上的第一个入口。
   *
   * 初始值：编辑时按这张账单已记的基点去匹配（bills.tax_rate_id 目前还没有
   * 被写入过，见下面的注释，所以只能按 bps 反查）；新建时用默认税率——
   * 商户日常收到的账单绝大多数适用同一个税率，让他每次手选一遍只会增加漏选。
   */
  const [taxRateId, setTaxRateId] = useState<string>(() => {
    if (bill) {
      const matched = taxRates.find((rate) => rate.rateBps === bill.taxRateBps);
      return matched?.id ?? '';
    }
    return taxRates.find((rate) => rate.rateBps > 0)?.id ?? '';
  });
  // 新建时默认「已收到」——这个词的意思就是负债已经成立，费用已经发生，
  // 权责发生制下这一刻就该入账。勾上才存草稿。与发票默认存草稿相反，
  // 理由写在 server/actions/bills.ts 顶部。
  const [keepDraft, setKeepDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedRate = taxRates.find((rate) => rate.id === taxRateId) ?? null;

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

    const payload = {
      contactId,
      issueDate,
      dueDate,
      currency,
      // 服务端收的是百分数字符串，不是基点也不是税率 id。
      //
      // CreateBillInput 里没有 taxRateId 这个字段，insertBill 那边写死了
      // `taxRateId: null`——所以选中的是「哪一条税率记录」这件事今天存不下来，
      // 存下来的只有税率本身。等 CreateBillInput 接受 taxRateId 之后，
      // 这里把 selectedRate.id 一并传过去即可，界面不用再动。已在报告里记下。
      taxRatePercent: selectedRate ? bpsToPercent(selectedRate.rateBps) : '0',
      notes: notes || undefined,
      items: items.map((item) => ({
        description: item.description,
        amount: item.amount || '0',
      })),
    };

    try {
      if (isEdit && bill) {
        await updateBill(orgSlug, bill.id, payload);
      } else {
        await createBill(orgSlug, { ...payload, status: keepDraft ? 'draft' : 'received' });
      }
      // ?saved=1：回执由列表页渲染。理由见 components/invoices/invoice-form.tsx。
      router.push(`/${orgSlug}/bills?saved=1`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  const lifecycle = isEdit ? (
    <DocumentLifecycle
      caption={t.bills.lifecycle}
      steps={[
        { value: 'draft', label: t.bills.statusDraft },
        { value: 'received', label: t.bills.statusReceived },
        { value: 'partially_paid', label: t.bills.statusPartiallyPaid },
        { value: 'paid', label: t.bills.statusPaid },
      ]}
      // overdue 是 received 迟到了，不是另一步。同发票。
      current={status === 'overdue' ? 'received' : status}
      voided={isVoided}
      voidedLabel={t.bills.statusVoided}
      notice={
        isVoided
          ? t.bills.voidedNotice
          : status === 'paid'
            ? t.bills.paidNotice
            : isPosted
              ? t.bills.postedNotice
              : t.bills.draftNotice
      }
    />
  ) : null;

  if (isVoided) {
    return <>{lifecycle}</>;
  }

  return (
    <>
      {lifecycle}

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
        <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {currencies.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>

        {taxRates.length > 0 ? (
          <>
            <label htmlFor="taxRateId">{t.bills.taxRate}</label>
            <select
              id="taxRateId"
              value={taxRateId}
              onChange={(e) => setTaxRateId(e.target.value)}
              aria-describedby="taxRateHint"
            >
              <option value="">{t.bills.noTaxRate}</option>
              {taxRates.map((rate) => (
                <option key={rate.id} value={rate.id}>
                  {rate.name} ({bpsToPercent(rate.rateBps)}%)
                </option>
              ))}
            </select>
            <p className="field-hint" id="taxRateHint">
              {t.bills.taxRateHint}
            </p>
          </>
        ) : (
          // 一家还没配税率的公司看到的是一句能照着做的话，而不是一个
          // 只有「不含税」一项的下拉框。这里不渲染 <label htmlFor>：
          // 它指不到任何可标注的控件，读屏器会报一个悬空标签。
          <p className="field-hint">{t.bills.noTaxRatesYet}</p>
        )}

        <fieldset className="invoice-items">
          <legend>{t.bills.items}</legend>

          {/* 列名，理由同发票表单。账单行只有「描述 + 金额」两栏，用
              --pair 修饰类换一套列宽——它此前套用的是发票那套四列网格
              （1fr 80px 120px 120px），金额输入框落在 80px 的那一列里。 */}
          <div className="invoice-item-head invoice-item-head--pair" aria-hidden="true">
            <span>{t.bills.description}</span>
            <span>{t.bills.amount}</span>
          </div>

          {items.map((item, index) => (
            <div key={index} className="invoice-item-row invoice-item-row--pair">
              <input
                placeholder={t.bills.description} aria-label={t.bills.description}
                value={item.description}
                onChange={(e) => updateItem(index, 'description', e.target.value)}
                required
              />
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder={t.bills.amount} aria-label={t.bills.amount}
                value={item.amount}
                onChange={(e) => updateItem(index, 'amount', e.target.value)}
                required
              />
              {items.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeItem(index)}
                  className="btn-small"
                  aria-label={`${t.common.delete} ${t.bills.items} ${index + 1}`}
                >
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

        {!isEdit ? (
          <label className="doc-toggle" htmlFor="keepDraft">
            <input
              id="keepDraft"
              type="checkbox"
              checked={keepDraft}
              onChange={(e) => setKeepDraft(e.target.checked)}
            />
            <span>
              {t.bills.saveAsDraft}
              <span className="field-hint">{t.bills.saveAsDraftHint}</span>
            </span>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}

        <div className="form-actions">
          <button type="submit" disabled={pending}>
            {pending ? t.common.loading : isEdit ? t.bills.saveChanges : t.bills.save}
          </button>
        </div>
      </form>
    </>
  );
}
