'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { createPayment } from '@/server/actions/payments';
import { todayLocalISO } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { currencyExponent, formatMinorToDecimal, parseDecimalToMinor } from '@/server/domain/money';
import { RateField } from '@/components/transaction/rate-field';

type Contact = { id: string; name: string };

type OutstandingInvoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  contactId: string;
  totalMinor: bigint;
  paidMinor: bigint;
  currency: string;
};

type OutstandingBill = {
  id: string;
  billNumber: string;
  vendorName: string;
  contactId: string;
  totalMinor: bigint;
  paidMinor: bigint;
  currency: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  contacts: Contact[];
  type: 'received' | 'made';
  currencies: string[];
  /** 公司本位币。汇率栏与币种缺省都用它。 */
  baseCurrency: string;
  outstandingInvoices?: OutstandingInvoice[];
  outstandingBills?: OutstandingBill[];
};

/**
 * 输入框里那个还没打完的十进制字符串 → 最小单位整数；折不动就当零。
 *
 * 为什么不是 `parseFloat`：这里的每一个值最终都会变成账上的一个数。
 * 用户在一张 JPY 收款上敲 1000，`parseFloat(...)` 得到 1000，再
 * `.toFixed(2)` 得到 '1000.00'——而 JPY 的 exponent 是 0，服务端的
 * parseDecimalToMinor 会直接拒掉「小数位比这个币种允许的多」。就算币种是
 * MYR，0.1 + 0.2 在浮点下也是 0.30000000000000004，累加十几行之后
 * 就会和服务端用整数加出来的合计差上一分，而合计恰恰是用来跟
 * 「这笔款一共多少钱」比大小的那个数。
 *
 * 折不动时返回 0 而不是抛：这个函数在**每一次按键**上都会跑一遍，用户打到
 * 一半的 '12.' 不是错误，只是还没打完。真正的校验由服务端做——它拿到的
 * 是用户敲的原始字符串，不是这里折算出来的中间值。
 */
function minorOrZero(value: string, exponent: number): bigint {
  const trimmed = value.trim();
  if (trimmed === '') return 0n;
  try {
    return parseDecimalToMinor(trimmed, exponent);
  } catch {
    return 0n;
  }
}

/** 收付方式。文案走 catalog，不在这里写死——见 lib/i18n 里那几条注释。 */
const METHODS = [
  { value: 'cash', key: 'methodCash' },
  { value: 'bank_transfer', key: 'methodBankTransfer' },
  { value: 'cheque', key: 'methodCheque' },
  { value: 'online', key: 'methodOnline' },
  { value: 'other', key: 'methodOther' },
] as const;

export function PaymentForm({
  orgSlug,
  locale,
  i18n,
  contacts,
  type: initialType,
  currencies,
  baseCurrency,
  outstandingInvoices,
  outstandingBills,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const today = todayLocalISO();

  const [paymentType, setPaymentType] = useState<'received' | 'made'>(initialType);
  const [contactId, setContactId] = useState(contacts[0]?.id ?? '');
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  // 缺省本位币，不是 currencies[0]。SUPPORTED_CURRENCIES 的第一项碰巧是
  // MYR，所以这一处以前「看着是对的」——但它对的是列表顺序，不是这家公司。
  // 列表一重排就静默改掉所有新收款的币种。
  const [currency, setCurrency] = useState(baseCurrency);
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedItems, setSelectedItems] = useState<
    { invoiceId?: string; billId?: string; amount: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);

  // 这个币种有几位小数。写死 2 的代价是零位小数的币种（JPY/KRW/VND）
  // 整整差两个数量级；`step="0.01"` 同理——它在 JPY 上允许用户敲出一个
  // 服务端一定会拒的 1000.50。
  const exponent = currencyExponent(currency);
  const amountStep = exponent === 0 ? '1' : '0.01';

  /**
   * 可核销的单据：只列这位往来对象、这个币种、还有余额的。
   *
   * 三个条件都不是装饰：
   *   - 币种不同的，createPayment 会直接拒（「这张单据是 USD，而这笔钱是
   *     MYR，请按单据的币种记」）。列出来只是让用户白点一次。
   *   - 不是这位往来对象的，业务上无法解释；服务端今天其实不查这一条
   *     （只查单据属不属于本公司），所以这里挡住就是唯一的一道。
   *   - 余额为零的已经收讫，再核销一次只会让 payment_items 上多一条谁也
   *     对不上的记录。
   */
  const unpaidInvoices = useMemo(
    () =>
      (outstandingInvoices ?? []).filter(
        (inv) =>
          inv.totalMinor - inv.paidMinor > 0n &&
          inv.currency === currency &&
          inv.contactId === contactId,
      ),
    [outstandingInvoices, currency, contactId],
  );

  const unpaidBills = useMemo(
    () =>
      (outstandingBills ?? []).filter(
        (bill) =>
          bill.totalMinor - bill.paidMinor > 0n &&
          bill.currency === currency &&
          bill.contactId === contactId,
      ),
    [outstandingBills, currency, contactId],
  );

  /**
   * 勾上一张单据时，核销金额预填成它的剩余未结额。
   *
   * 不预填的代价不是「少一点方便」：勾了不填等于送 amount '0' 过去，而服务端
   * 对每一条核销明细都要求金额大于零（「Each applied amount must be greater
   * than zero.」）。也就是说「勾一张发票、金额栏留空、提交」这条最自然的路径
   * 必然失败一次。全额收款本来就是绝大多数情况，把它做成默认值。
   *
   * 预填值由 formatMinorToDecimal 从整数折回十进制字符串，不经过浮点，
   * 零位小数的币种（JPY）折出来就是 '1000' 而不是 '1000.00'。
   */
  function toggleItem(item: { id: string; kind: 'invoice' | 'bill'; remainingMinor: bigint }) {
    setSelectedItems((prev) => {
      const exists = prev.find((si) =>
        item.kind === 'invoice' ? si.invoiceId === item.id : si.billId === item.id,
      );
      if (exists) {
        return prev.filter((si) =>
          item.kind === 'invoice' ? si.invoiceId !== item.id : si.billId !== item.id,
        );
      }
      const prefill = formatMinorToDecimal(item.remainingMinor, exponent);
      const newItem =
        item.kind === 'invoice'
          ? { invoiceId: item.id, amount: prefill }
          : { billId: item.id, amount: prefill };
      return [...prev, newItem];
    });
  }

  function updateItemAmount(index: number, value: string) {
    setSelectedItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, amount: value } : item)),
    );
  }

  /**
   * 已核销合计。全程 bigint，因为它要和「这笔款一共多少钱」比大小，
   * 而两个浮点数相加之后的比大小会在边界上给出和服务端相反的答案。
   */
  const appliedMinor = useMemo(
    () => selectedItems.reduce((sum, item) => sum + minorOrZero(item.amount, exponent), 0n),
    [selectedItems, exponent],
  );

  /** 金额栏留空时提交出去的那个值：正好等于已核销合计。 */
  const appliedDecimal = formatMinorToDecimal(appliedMinor, exponent);

  /**
   * 核销超额。服务端会拒（sumMinor(itemAmounts) > amountMinor），但那句话
   * 要等一个来回才看得到，而用户此时已经填完了整张表。
   *
   * 只在金额栏真的填了东西时才判：留空意味着「按核销合计记」，那时两者
   * 恒等，谈不上超额。
   */
  const enteredMinor = minorOrZero(amount, exponent);
  const overApplied = amount.trim() !== '' && enteredMinor > 0n && appliedMinor > enteredMinor;

  /**
   * 一张单据都没勾，不再是错误。
   *
   * 这里原来会挡下提交并说「一笔收款必须说明它核销的是哪一张」——那是
   * 承认做不到，不是做到了：payment_items 上的 payment_items_one_target
   * 当时要求 invoice_id / bill_id **恰好一个非空**（0009），一笔不核销任何
   * 单据的预收在数据库层面就插不进去。
   *
   * 0024 把那条 CHECK 放宽成「至多一个非空」，服务端也有了去处（预收账款 /
   * 预付账款，见 server/services/prepayment.ts），所以这条路现在是通的：
   * 没勾单据 = 这笔钱先挂账。表单要做的只剩两件事——把「它会挂在哪里」
   * 说清楚，以及在没有核销明细时要求用户自己填金额（否则送出去的是
   * 核销合计 0，服务端必然拒）。
   */
  const settlementMissing = selectedItems.length === 0;

  /**
   * 会挂到预收/预付上的那一截 = 填的金额 − 已核销合计。
   *
   * 金额栏留空时恒为零（留空的含义就是「这笔款正好等于核销合计」）。
   * 全程 bigint：这个数要显示给用户看，而它和服务端算出来的必须是同一个。
   */
  const enteredMinorForHint = amount.trim() === '' ? appliedMinor : minorOrZero(amount, exponent);
  const onAccountMinor =
    enteredMinorForHint > appliedMinor ? enteredMinorForHint - appliedMinor : 0n;

  const onAccountHint =
    paymentType === 'received'
      ? i18n.payments.onAccountHintReceived
      : i18n.payments.onAccountHintMade;

  const candidates = paymentType === 'received' ? unpaidInvoices : unpaidBills;
  const noCandidates = candidates.length === 0;

  /**
   * 一张单据都没勾时，金额栏就是这笔钱的唯一来源，不能留空。
   *
   * 留空的含义是「按核销合计记」，而核销合计此时是零——服务端会拒
   * （「Transaction amount must be greater than zero.」）。挡在这里才不用
   * 等一个来回，而且说得出是哪一栏的事。
   */
  const amountMissing = appliedMinor === 0n && minorOrZero(amount, exponent) <= 0n;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);

    if (amountMissing) {
      setError(i18n.payments.amountRequired);
      return;
    }
    if (overApplied) {
      setError(
        interpolate(i18n.payments.overApplied, {
          applied: formatMoney(appliedMinor, currency),
          amount: formatMoney(enteredMinor, currency),
        }),
      );
      return;
    }

    setPending(true);
    setError(null);

    // RateField 刻意不提交自动查到的汇率（只有用户手工改过才带 name），
    // 所以这里从 form 里取，而不是从 React state 里取——让服务端在本币
    // 与「自动汇率」两种情况下都走它自己的解析分支，rate_source 才记得对。
    // 见 components/transaction/rate-field.tsx。
    const formData = new FormData(e.currentTarget as HTMLFormElement);
    const exchangeRate = formData.get('exchangeRate')
      ? String(formData.get('exchangeRate'))
      : undefined;

    try {
      const items = selectedItems.map((item) => ({
        invoiceId: item.invoiceId ?? null,
        billId: item.billId ?? null,
        amount: item.amount || '0',
      }));

      await createPayment(orgSlug, {
        contactId,
        type: paymentType,
        // 金额栏留空 = 「这笔款就是核销合计」。这里送的是由整数折回来的
        // 十进制字符串，不是浮点 toFixed 出来的近似值。
        amount: amount || appliedDecimal,
        currency,
        exchangeRate,
        paymentDate: date,
        method: method as 'cash' | 'bank_transfer' | 'cheque' | 'online' | 'other',
        reference: reference || undefined,
        notes: notes || undefined,
        items,
      });
      router.push(`/${orgSlug}/payments`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label>{i18n.payments.type}</label>
      <div className="radio-group">
        <label>
          <input
            type="radio"
            name="paymentType"
            value="received"
            checked={paymentType === 'received'}
            onChange={() => {
              setPaymentType('received');
              // 方向一变，之前勾的单据全都是另一侧的，必须清空——
              // 服务端会拒绝「收款核销账单」，但那时用户已经填完了。
              setSelectedItems([]);
            }}
          />
          {i18n.payments.received}
        </label>
        <label>
          <input
            type="radio"
            name="paymentType"
            value="made"
            checked={paymentType === 'made'}
            onChange={() => {
              setPaymentType('made');
              setSelectedItems([]);
            }}
          />
          {i18n.payments.made}
        </label>
      </div>

      <label htmlFor="contactId">{i18n.invoices.customer}</label>
      <select
        id="contactId"
        value={contactId}
        onChange={(e) => {
          setContactId(e.target.value);
          setSelectedItems([]);
        }}
        required
      >
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <label htmlFor="date">{i18n.transaction.date}</label>
      <input
        id="date"
        type="date"
        required
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />

      <label htmlFor="amount">{i18n.transaction.amount}</label>
      <input
        id="amount"
        type="number"
        min="0"
        step={amountStep}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder={appliedMinor > 0n ? appliedDecimal : ''}
        aria-describedby="amountHint"
        // 两种无效：核销超额，以及「一张单据都没勾却也没填金额」。后者
        // 只在用户按过提交之后才标红——打字打到一半就把输入框标成错误，
        // 说的是一件还没发生的事。
        aria-invalid={overApplied || (submitted && amountMissing) ? true : undefined}
      />
      {/* 已核销合计一直显示，不只在出错时才出现：用户需要在按下提交之前
          就看得出「我勾的这几张加起来是多少」，否则超额这件事只能靠服务端
          在一个来回之后告诉他。role="status" 而不是 alert——它多数时候
          陈述的是一个正常的数。 */}
      <p className="field-hint" id="amountHint" role="status">
        {i18n.payments.appliedTotal}: {formatMoney(appliedMinor, currency)}
        {overApplied ? (
          <>
            {' '}
            <span className="doc-inline-error">
              {interpolate(i18n.payments.overApplied, {
                applied: formatMoney(appliedMinor, currency),
                amount: formatMoney(enteredMinor, currency),
              })}
            </span>
          </>
        ) : null}
      </p>

      <label htmlFor="currency">{i18n.transaction.currency}</label>
      <select
        id="currency"
        value={currency}
        onChange={(e) => {
          setCurrency(e.target.value);
          // 币种一变，能核销的单据整批都换了，勾选留不得。
          setSelectedItems([]);
        }}
      >
        {currencies.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>

      {/*
        汇率栏。此前收付款表单上没有这一栏，于是服务端解析汇率时传的是
        `manualRateEntry: 'unavailable'`，而那条路径的报错文案是「去
        Transactions 页面自己记一笔，那里能填汇率」——对一笔**收款**这是
        错误建议：自己记一笔交易不会核销任何发票，发票照样挂在应收上。
        现在用户能就地填汇率，服务端那个常量应当改回 'available'。

        RateField 在本币交易下整个不渲染，也就不会提交 exchangeRate，
        服务端因此走 currency === baseCurrency 那一支、把 rate_source
        记成 'auto'——这正是它被写成这样的原因，别在外面补一个 '1'。
      */}
      <RateField
        orgSlug={orgSlug}
        currency={currency}
        baseCurrency={baseCurrency}
        occurredOn={date}
        amount={amount || appliedDecimal}
        locale={locale}
      />

      <label htmlFor="method">{i18n.payments.method}</label>
      <select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
        {METHODS.map((m) => (
          <option key={m.value} value={m.value}>
            {i18n.payments[m.key]}
          </option>
        ))}
      </select>

      <label htmlFor="reference">{i18n.payments.reference}</label>
      <input
        id="reference"
        type="text"
        maxLength={200}
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />

      <fieldset aria-describedby="settlementHint">
        <legend>
          {paymentType === 'received' ? i18n.payments.applyToInvoices : i18n.payments.applyToBills}
        </legend>

        {noCandidates ? (
          <p className="field-hint" id="settlementHint">
            {interpolate(
              paymentType === 'received'
                ? i18n.payments.noOutstandingInvoices
                : i18n.payments.noOutstandingBills,
              { currency },
            )}
          </p>
        ) : (
          <>
            {paymentType === 'received'
              ? unpaidInvoices.map((inv) => {
                  const remainingMinor = inv.totalMinor - inv.paidMinor;
                  const isSelected = selectedItems.some((si) => si.invoiceId === inv.id);
                  return (
                    <label key={inv.id} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() =>
                          toggleItem({ id: inv.id, kind: 'invoice', remainingMinor })
                        }
                      />
                      <span>
                        {inv.invoiceNumber} · {inv.customerName}{' '}
                        {/* 金额一律由 formatMoney 格式化：Number(minor)/100
                            对零位小数的币种（JPY 等）直接差两个数量级。 */}
                        ({formatMoney(remainingMinor, inv.currency)})
                      </span>
                      {isSelected ? (
                        <input
                          type="number"
                          min="0"
                          step={amountStep}
                          aria-label={`${i18n.transaction.amount} ${inv.invoiceNumber}`}
                          value={selectedItems.find((si) => si.invoiceId === inv.id)?.amount ?? ''}
                          onChange={(e) => {
                            const idx = selectedItems.findIndex((si) => si.invoiceId === inv.id);
                            if (idx >= 0) updateItemAmount(idx, e.target.value);
                          }}
                        />
                      ) : null}
                    </label>
                  );
                })
              : unpaidBills.map((bill) => {
                  const remainingMinor = bill.totalMinor - bill.paidMinor;
                  const isSelected = selectedItems.some((si) => si.billId === bill.id);
                  return (
                    <label key={bill.id} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleItem({ id: bill.id, kind: 'bill', remainingMinor })}
                      />
                      <span>
                        {bill.billNumber} · {bill.vendorName} (
                        {formatMoney(remainingMinor, bill.currency)})
                      </span>
                      {isSelected ? (
                        <input
                          type="number"
                          min="0"
                          step={amountStep}
                          aria-label={`${i18n.transaction.amount} ${bill.billNumber}`}
                          value={selectedItems.find((si) => si.billId === bill.id)?.amount ?? ''}
                          onChange={(e) => {
                            const idx = selectedItems.findIndex((si) => si.billId === bill.id);
                            if (idx >= 0) updateItemAmount(idx, e.target.value);
                          }}
                        />
                      ) : null}
                    </label>
                  );
                })}

            <p className="field-hint" id="settlementHint" role="status">
              {settlementMissing ? i18n.payments.onAccount : null}
            </p>
          </>
        )}

        {/*
          挂账说明。只在真的会挂账时出现——一笔全额核销的收款不该被一段
          关于预收账款的解释打扰。

          说的是「这笔钱会去哪个科目、为什么是那里」，而不是「已挂账」：
          一个不懂会计的店主看到「预收账款」四个字大概率不知道那是负债，
          而「在交货之前那是你欠客户的，不是收入」他一读就懂——这正是这
          条提示存在的理由。
        */}
        {onAccountMinor > 0n ? (
          <p className="pp-on-account" role="status">
            <strong>
              {interpolate(i18n.payments.onAccountAmount, {
                amount: formatMoney(onAccountMinor, currency),
              })}
            </strong>
            <span className="field-hint">{onAccountHint}</span>
          </p>
        ) : null}
      </fieldset>

      <label htmlFor="notes">{i18n.invoices.notes}</label>
      <textarea
        id="notes"
        maxLength={2000}
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
        {/* 不再因为「没有可核销的单据」而禁用。那条判断成立的前提是
            「一笔不核销任何单据的收款必然失败」——0024 之后它不再成立：
            那样的一笔钱会挂在预收/预付账款上，这正是定金该有的记法。
            一个灰掉的按钮说不出任何理由，而现在它也没有理由可说。 */}
        <button type="submit" disabled={pending}>
          {pending ? t.common.loading : i18n.payments.save}
        </button>
      </div>
    </form>
  );
}
