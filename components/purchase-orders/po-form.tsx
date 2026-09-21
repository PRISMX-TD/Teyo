'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createPurchaseOrder, updatePurchaseOrderAction } from '@/server/actions/purchase_orders';
import { todayLocalISO } from '@/lib/date';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import { RateField } from '@/components/transaction/rate-field';

type Vendor = {
  id: string;
  name: string;
};

/** 页面从 server/repositories/tax.ts 的 listTaxRates 查出来，按语言取好名字再传进来。 */
export type PoTaxRateOption = {
  id: string;
  name: string;
  rateBps: number;
};

/**
 * 编辑模式下这张表单需要的那张采购单，已经摊平成字符串。
 *
 * 不直接收 PurchaseOrderWithItems：那上面的数量是放大 10^4 的 bigint、
 * 金额是最小单位 bigint、汇率是放大 10^8 的 bigint，还原各有各的函数
 * （formatScaledQuantity / formatMinorToDecimal / formatScaledRate），
 * 其中头一个住在 server/repositories/inventory.ts 里——把一个仓储模块拖进
 * 客户端包只为了格式化三个数字，不值。换算在页面（服务端）做一次。
 */
export type PoEditable = {
  id: string;
  poNumber: string;
  contactId: string;
  issueDate: string;
  expectedDate: string | null;
  currency: string;
  /** 十进制字符串，由 formatScaledRate 从 exchange_rate 那一列还原。 */
  exchangeRate: string;
  notes: string | null;
  items: LineItem[];
};

type Props = {
  orgSlug: string;
  locale: Locale;
  vendors: Vendor[];
  currencies: string[];
  /** 公司本位币。理由见 components/invoices/invoice-form.tsx 上的同名字段。 */
  baseCurrency: string;
  taxRates: PoTaxRateOption[];
  /**
   * 有值即编辑模式。只有草稿会走到这里——已发送的那一份在供应商手上了，
   * 页面负责在这之前就把表单换成只读视图。
   */
  purchaseOrder?: PoEditable | null;
};

type LineItem = {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRateId: string;
};

function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

export function PoForm({
  orgSlug,
  locale,
  vendors,
  currencies,
  baseCurrency,
  taxRates,
  purchaseOrder = null,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const today = todayLocalISO();
  const isEdit = purchaseOrder !== null;

  const [contactId, setContactId] = useState(purchaseOrder?.contactId ?? vendors[0]?.id ?? '');
  const [issueDate, setIssueDate] = useState(purchaseOrder?.issueDate ?? today);
  const [expectedDate, setExpectedDate] = useState(purchaseOrder?.expectedDate ?? '');
  const [currency, setCurrency] = useState(purchaseOrder?.currency ?? baseCurrency);
  const [notes, setNotes] = useState(purchaseOrder?.notes ?? '');
  const [items, setItems] = useState<LineItem[]>(
    purchaseOrder && purchaseOrder.items.length > 0
      ? purchaseOrder.items
      : [{ description: '', quantity: '1', unitPrice: '', taxRateId: '' }],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function updateItem(index: number, field: keyof LineItem, value: string) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  }

  function addItem() {
    setItems((prev) => [
      ...prev,
      { description: '', quantity: '1', unitPrice: '', taxRateId: '' },
    ]);
  }

  function removeItem(index: number) {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    // 汇率：RateField 只在用户手工填过时才带 name 提交。
    //
    // 这一栏是必须加的，不是锦上添花：createPurchaseOrder 的 resolvePoRate
    // 在「币种 ≠ 本位币且没给汇率」时直接抛错。此前这张表单一个汇率字段
    // 都没有，于是任何一张外币采购单都开不出来，用户只会读到一句
    // 「Enter the USD to MYR rate for this purchase order」而界面上没有
    // 任何地方能填。
    const formData = new FormData(e.currentTarget as HTMLFormElement);
    const exchangeRate = formData.get('exchangeRate')
      ? String(formData.get('exchangeRate'))
      : undefined;

    try {
      const exponent = currencyExponent(currency);

      const payloadItems = items.map((item) => ({
        description: item.description,
        // 数量原样传字符串。原来这里是 `parseFloat(item.quantity) || 0`，
        // 而行金额又用 `Math.round(qty)` 把它四舍五入成整数——采购 2.5 吨
        // 按 3 吨计价，单据与明细各自自洽，没有任何地方看得出来。服务端的
        // parseQuantityToScaled 收字符串，按四位小数定标，一分不差。
        quantity: item.quantity || '1',
        // 十进制字符串 → 最小单位整数，走 parseDecimalToMinor 而不是
        // `Math.round(parseFloat(x) * 100)`。后者对 JPY 这种零位小数的币种
        // 直接差两个数量级（1000 日元变成 100000），而且浮点乘法本身就会
        // 在某些值上偏一分。exponent 由币种决定，不是写死的 100。
        unitPriceMinor: parseDecimalToMinor(
          (item.unitPrice || '0').trim(),
          exponent,
        ).toString(),
        // amountMinor 不传：服务端 totalsFor 在缺省时用整数 half-up 的
        // extendQuantity 自己算（单价 × 数量）。前端算一遍再传过去，等于
        // 让「行金额」有两个来源，而只有其中一个受记账边界的舍入规则约束。
        taxRateId: item.taxRateId || undefined,
      }));

      if (isEdit && purchaseOrder) {
        await updatePurchaseOrderAction(orgSlug, purchaseOrder.id, {
          contactId,
          issueDate,
          // expectedDate 与 notes 在仓储层是「不传就清空」的语义（那是有意的，
          // 见 updatePurchaseOrder 上的注释：把预计到货日清掉是用户真的会做的
          // 动作）。所以这张表单每次都把这两栏当前的值原样送过去，空就是空。
          expectedDate: expectedDate || undefined,
          currency,
          exchangeRate,
          notes: notes || undefined,
          items: payloadItems,
        });
      } else {
        await createPurchaseOrder(orgSlug, {
          contactId,
          issueDate,
          expectedDate: expectedDate || undefined,
          currency,
          exchangeRate,
          notes: notes || undefined,
          items: payloadItems,
        });
      }
      // ?saved=1：回执由列表页渲染。理由见 components/invoices/invoice-form.tsx。
      router.push(`/${orgSlug}/purchase-orders?saved=1`);
      router.refresh();
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
      <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
        {currencies.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>

      {/* amount 传空串：采购单没有一个总金额输入框，合计是各行乘加出来的，
          在前端用浮点算一个预览值只会和服务端的整数结果差一两分。
          汇率本身仍然照常查、照常能改成手工。 */}
      <RateField
        orgSlug={orgSlug}
        currency={currency}
        baseCurrency={baseCurrency}
        occurredOn={issueDate}
        amount=""
        locale={locale}
        // 编辑时带上这张单当初记下的汇率，并原样提交回去。不带的话，
        // updatePurchaseOrderAction 在币种没变时会沿用库里那个值——结果是
        // 对的，但屏幕上那一栏显示的会是今天查到的汇率，与真正保存下去的
        // 不是同一个数。让看到的和存下去的是同一个。
        initialRate={isEdit ? purchaseOrder?.exchangeRate : undefined}
        initialSource={isEdit ? 'manual' : undefined}
      />

      <fieldset className="invoice-items">
        <legend>{t.purchaseOrders.items}</legend>

        {/* 列名。此前每一行只靠 placeholder 说明这一栏是什么——一开始
            打字它就消失，第二行往后用户只能靠列宽去猜哪个是数量哪个是
            单价。表头写一次，所有行共用。aria-hidden：每个输入框自己
            已经带了 aria-label，读屏器不必再听一遍列名。 */}
        <div className="invoice-item-head" aria-hidden="true">
          <span>{t.purchaseOrders.description}</span>
          <span>{t.purchaseOrders.quantity}</span>
          <span>{t.purchaseOrders.unitPrice}</span>
        </div>

        {items.map((item, index) => (
          <div key={index} className="invoice-item-row">
            <input
              placeholder={t.purchaseOrders.description} aria-label={t.purchaseOrders.description}
              value={item.description}
              onChange={(e) => updateItem(index, 'description', e.target.value)}
              required
            />
            <input
              type="number"
              min="0.0001"
              step="0.0001"
              placeholder={t.purchaseOrders.quantity} aria-label={t.purchaseOrders.quantity}
              value={item.quantity}
              onChange={(e) => updateItem(index, 'quantity', e.target.value)}
            />
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder={t.purchaseOrders.unitPrice} aria-label={t.purchaseOrders.unitPrice}
              value={item.unitPrice}
              onChange={(e) => updateItem(index, 'unitPrice', e.target.value)}
              required
            />
            {/* 税率从 tax_rates 表里选，选出来的是一个 uuid。
                原来这里是写死的 ['0','6','10','12'] 加一句
                `taxRateId: taxRate > 0 ? undefined : undefined`——两条分支
                都是 undefined，也就是无论选什么都不传。这个下拉框此前
                纯属装饰：用户选了 6%，采购单上一个字节都没变。 */}
            <select
              value={item.taxRateId}
              onChange={(e) => updateItem(index, 'taxRateId', e.target.value)}
              aria-label={`${t.purchaseOrders.tax} ${index + 1}`}
            >
              <option value="">{t.purchaseOrders.noTax}</option>
              {taxRates.map((rate) => (
                <option key={rate.id} value={rate.id}>
                  {rate.name} ({bpsToPercent(rate.rateBps)}%)
                </option>
              ))}
            </select>
            {items.length > 1 ? (
              <button
                type="button"
                onClick={() => removeItem(index)}
                className="btn-small"
                aria-label={`${t.common.delete} ${t.purchaseOrders.items} ${index + 1}`}
              >
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
          {pending
            ? t.common.loading
            : isEdit
              ? t.purchaseOrders.saveChanges
              : t.purchaseOrders.save}
        </button>
      </div>
    </form>
  );
}
