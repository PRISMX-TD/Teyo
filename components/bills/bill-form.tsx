'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { createBill, updateBill } from '@/server/actions/bills';
import { addMonthsLocalISO } from '@/lib/date';
import { localDateFromISO, useLocalToday } from '@/components/ui/use-local-today';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import type { BillDetail } from '@/server/repositories/bills';
import { DocumentLifecycle } from '@/components/invoices/document-lifecycle';
import { Plus, X } from '@/components/ui/icons';

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
  /**
   * 只看不改。详情页只要 transaction:read，而 updateBill 要
   * transaction:edit:any——不分出这一支，记账员与只读用户看到的是一张
   * 填得动、却必然保存失败的表单。
   */
  readOnly?: boolean;
  /**
   * 采购单转账单（bills/new?fromPo=<id>）时由页面按那张采购单预填。
   * 供应商与币种锁住——服务端 assertPurchaseOrderBillable 也会拒绝不一致的；
   * 明细与税率可改，供应商实际开来的账单不一定与采购单一字不差。
   */
  fromPurchaseOrder?: BillFromPurchaseOrder | null;
  /** 详情页的摘要卡（合计 / 已付 / 待付），由页面在服务端算好，画在状态条与表单之间。 */
  summary?: ReactNode;
  /** 已过到期日且没付清。逾期不落库，由页面按公司时区的「今天」推出来。 */
  overdue?: boolean;
};

export type BillFromPurchaseOrder = {
  id: string;
  poNumber: string;
  contactId: string;
  currency: string;
  /** '' = 不含税。 */
  taxRateId: string;
  /** 采购单各行税率不一致：账单只有一个税率，提醒用户核对。 */
  taxRatesDiffer: boolean;
  items: LineItem[];
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
  readOnly = false,
  fromPurchaseOrder = null,
  summary = null,
  overdue = false,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const isEdit = bill !== null;
  const status: string = bill?.status ?? 'draft';
  const isVoided = bill !== null && (status === 'voided' || bill.voidedAt !== null);
  const isPosted = bill?.transactionId != null;

  // 编辑时 bill 优先；新建且来自采购单时用采购单预填；否则空白。
  const source = bill ? null : fromPurchaseOrder;
  // 已经从采购单转来的账单，编辑时供应商与币种同样锁住（updateBill 会拒绝）。
  const lockedToPo = source !== null || bill?.purchaseOrderId != null;

  const [contactId, setContactId] = useState(
    bill?.contactId ?? source?.contactId ?? contacts[0]?.id ?? '',
  );
  // 默认日期等水合完成后才取设备上的今天，见 components/ui/use-local-today.ts。
  const today = useLocalToday();
  const [issueDateInput, setIssueDate] = useState<string | null>(bill?.issueDate ?? null);
  const [dueDateInput, setDueDate] = useState<string | null>(bill?.dueDate ?? null);
  const issueDate = issueDateInput ?? today;
  const dueDate = dueDateInput ?? (today ? addMonthsLocalISO(1, localDateFromISO(today)) : '');
  const [currency, setCurrency] = useState(bill?.currency ?? source?.currency ?? baseCurrency);
  const [notes, setNotes] = useState(bill?.notes ?? '');
  const [items, setItems] = useState<LineItem[]>(
    bill
      ? itemsOf(bill)
      : source && source.items.length > 0
        ? source.items
        : [{ description: '', amount: '' }],
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
   * 初始值：编辑时先认这张账单记下的 tax_rate_id，那条记录不在下拉里
   * （停用了，或是 tax_rate_id 落库之前的旧账单）才按基点反查；新建时用
   * 默认税率——商户日常收到的账单绝大多数适用同一个税率，让他每次手选
   * 一遍只会增加漏选。
   */
  const [taxRateId, setTaxRateId] = useState<string>(() => {
    if (bill) {
      const byId = bill.taxRateId
        ? taxRates.find((rate) => rate.id === bill.taxRateId)
        : undefined;
      const matched = byId ?? taxRates.find((rate) => rate.rateBps === bill.taxRateBps);
      return matched?.id ?? '';
    }
    // 来自采购单：认采购单行上的那条税率，不在下拉里（停用了）就留空让用户选。
    if (source) {
      return taxRates.some((rate) => rate.id === source.taxRateId) ? source.taxRateId : '';
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
    if (readOnly) return;
    setPending(true);
    setError(null);

    const payload = {
      contactId,
      issueDate,
      dueDate,
      currency,
      // 税率数值（百分数字符串）决定算多少税；taxRateId 记下选的是哪一条。
      // 后者原来没传——CreateBillInput 早就收它了，bills.tax_rate_id 却恒为
      // null，编辑时还会把已有的值清掉。
      taxRatePercent: selectedRate ? bpsToPercent(selectedRate.rateBps) : '0',
      taxRateId: selectedRate?.id ?? null,
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
        await createBill(orgSlug, {
          ...payload,
          status: keepDraft ? 'draft' : 'received',
          purchaseOrderId: source?.id ?? null,
        });
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
        <>
          {overdue && !isVoided ? (
            <span className="doc-inline-error bill-overdue-notice">{t.bills.overdueNotice}</span>
          ) : null}
          {isVoided
            ? t.bills.voidedNotice
            : readOnly
              ? t.common.noEditPermission
              : status === 'paid'
                ? t.bills.paidNotice
                : isPosted
                  ? t.bills.postedNotice
                  : t.bills.draftNotice}
        </>
      }
    />
  ) : null;

  if (isVoided) {
    return (
      <>
        {lifecycle}
        {summary}
      </>
    );
  }

  return (
    <>
      {lifecycle}
      {summary}

      <form onSubmit={handleSubmit} className="transaction-form">
        {/* display: contents：这一层只为把 disabled 一次传给所有字段，不参与
            .transaction-form 的纵向排版。 */}
        <fieldset disabled={readOnly} style={{ display: 'contents' }}>
        {source ? (
          <p className="field-hint" role="note">
            {interpolate(t.bills.convertingFromPo, { number: source.poNumber })}
            {source.taxRatesDiffer ? <> {t.bills.poTaxRatesDiffer}</> : null}
          </p>
        ) : null}

        <label htmlFor="contactId">{t.bills.vendor}</label>
        <select
          id="contactId"
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          disabled={lockedToPo}
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
          disabled={lockedToPo}
        >
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
                  {bpsToPercent(rate.rateBps)}% · {rate.name}
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
              {/* 金额包一层 .item-field：手机上表头收起，标签露在输入框上方。 */}
              <label className="item-field">
                <span className="item-field__label">{t.bills.amount}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder={t.bills.amount}
                  value={item.amount}
                  onChange={(e) => updateItem(index, 'amount', e.target.value)}
                  required
                />
              </label>
              {items.length > 1 && !readOnly ? (
                <button
                  type="button"
                  onClick={() => removeItem(index)}
                  className="btn-small"
                  aria-label={`${t.common.delete} ${t.bills.items} ${index + 1}`}
                >
                  <X size={16} weight="bold" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ))}

          {/* 只读时不画增删明细的按钮：灰着的「添加明细」只是在说一件做不到的事。 */}
          {!readOnly ? (
            <button type="button" onClick={addItem} className="add-button">
              <Plus size={16} weight="bold" aria-hidden="true" />
              {t.bills.addItem}
            </button>
          ) : null}
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

        {!readOnly ? (
          <div className="form-actions">
            <button type="submit" disabled={pending}>
              {pending ? t.common.loading : isEdit ? t.bills.saveChanges : t.bills.save}
            </button>
          </div>
        ) : null}
        </fieldset>
      </form>
    </>
  );
}
