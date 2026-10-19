'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { createPayment } from '@/server/actions/payments';
import { todayLocalISO } from '@/lib/date';
import { formatMoney } from '@/lib/format';
import { currencyExponent, formatMinorToDecimal, parseDecimalToMinor } from '@/server/domain/money';
import { RateField } from '@/components/transactions/rate-field';
import {
  defaultMoneyAccountId,
  type MoneyAccountOption,
  type PaymentMethod,
} from '@/lib/payment-methods';
import {
  isPicked,
  MAX_PAYMENT_REFERENCE_LENGTH,
  pickDocument,
  referenceFromDocuments,
  type PaymentDraft,
  type PickableDocument,
  type SelectedItem,
} from '@/lib/pick-document';

type Contact = { id: string; name: string };

type OutstandingInvoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  contactId: string;
  totalMinor: bigint;
  paidMinor: bigint;
  currency: string;
  /** YYYY-MM-DD */
  dueDate: string;
};

type OutstandingBill = {
  id: string;
  billNumber: string;
  vendorName: string;
  contactId: string;
  totalMinor: bigint;
  paidMinor: bigint;
  currency: string;
  /** YYYY-MM-DD */
  dueDate: string;
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
  /** 启用中的资金账户（现金、各个银行户口、电子钱包），按科目表顺序。 */
  moneyAccounts: MoneyAccountOption[];
  outstandingInvoices?: OutstandingInvoice[];
  outstandingBills?: OutstandingBill[];
  /**
   * 从发票（或账单）页的「记录收款 / 记录付款」进来时带的那一张。表单一打开
   * 就按它填好方向、往来对象、币种与核销金额，和在页面上点它一下是同一个效果。
   * 页面已经核实过它在未结清单里；不在的话传 null。
   */
  initialDocument?: { kind: 'invoice' | 'bill'; id: string } | null;
};

/** 一张未结单据在快捷清单里要显示的东西。 */
type QuickPick = PickableDocument & { number: string; contactName: string; dueDate: string };

function quickPicksOf(
  invoices: OutstandingInvoice[] | undefined,
  bills: OutstandingBill[] | undefined,
): { invoices: QuickPick[]; bills: QuickPick[] } {
  return {
    invoices: (invoices ?? [])
      .filter((inv) => inv.totalMinor - inv.paidMinor > 0n)
      .map((inv) => ({
        id: inv.id,
        kind: 'invoice',
        contactId: inv.contactId,
        currency: inv.currency,
        remainingMinor: inv.totalMinor - inv.paidMinor,
        number: inv.invoiceNumber,
        contactName: inv.customerName,
        dueDate: inv.dueDate,
      })),
    bills: (bills ?? [])
      .filter((bill) => bill.totalMinor - bill.paidMinor > 0n)
      .map((bill) => ({
        id: bill.id,
        kind: 'bill',
        contactId: bill.contactId,
        currency: bill.currency,
        remainingMinor: bill.totalMinor - bill.paidMinor,
        number: bill.billNumber,
        contactName: bill.vendorName,
        dueDate: bill.dueDate,
      })),
  };
}

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

/** 手机上快捷清单先露出的张数。 */
const QUICK_PICK_PREVIEW = 5;

export function PaymentForm({
  orgSlug,
  locale,
  i18n,
  contacts,
  type: initialType,
  currencies,
  baseCurrency,
  moneyAccounts,
  outstandingInvoices,
  outstandingBills,
  initialDocument = null,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const today = todayLocalISO();

  const quickPicks = useMemo(
    () => quickPicksOf(outstandingInvoices, outstandingBills),
    [outstandingInvoices, outstandingBills],
  );

  // 只在第一次渲染时算：带着某一张单据进来，表单就从「已经点过它」开始。
  const [initial] = useState<PaymentDraft>(() => {
    // 缺省本位币，不是 currencies[0]。SUPPORTED_CURRENCIES 的第一项碰巧是
    // MYR，所以这一处以前「看着是对的」——但它对的是列表顺序，不是这家公司。
    // 列表一重排就静默改掉所有新收款的币种。
    const base: PaymentDraft = {
      type: initialType,
      contactId: contacts[0]?.id ?? '',
      currency: baseCurrency,
      selectedItems: [],
    };
    const pool = initialDocument?.kind === 'bill' ? quickPicks.bills : quickPicks.invoices;
    const doc = initialDocument ? pool.find((d) => d.id === initialDocument.id) : undefined;
    return doc ? pickDocument(base, doc) : base;
  });

  const [paymentType, setPaymentType] = useState<'received' | 'made'>(initial.type);
  const [contactId, setContactId] = useState(initial.contactId);
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(initial.currency);
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  // 用户自己选过的账户；没选过时按方式给缺省值（现金 → 现金，其余 → 银行）。
  // 选过之后再改方式不去动它：多半是先选了「Maybank」再把方式从转账改成
  // 线上支付，两件事互不相干。
  const [chosenMoneyAccountId, setChosenMoneyAccountId] = useState<string | null>(null);
  const moneyAccountId = chosenMoneyAccountId ?? defaultMoneyAccountId(moneyAccounts, method);
  const [reference, setReference] = useState('');
  // 用户自己动过参考号没有。动过之后，再勾、再取消单据都不去改它——那多半
  // 是照着银行流水敲进去的号，被单据号盖掉就白敲了。
  const [referenceEdited, setReferenceEdited] = useState(false);
  const [notes, setNotes] = useState('');
  const [selectedItems, setSelectedItems] = useState<
    { invoiceId?: string; billId?: string; amount: string }[]
  >(initial.selectedItems);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  /** 手机上快捷清单先只露前几张，见下面 .payment-quick-pick 那一段。 */
  const [showAllPicks, setShowAllPicks] = useState(false);

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

  const draft: PaymentDraft = { type: paymentType, contactId, currency, selectedItems };

  /** 单据 id → 单据号，给参考号的缺省值用。 */
  const documentNumbers = useMemo(() => {
    const numbers = new Map<string, string>();
    for (const inv of outstandingInvoices ?? []) numbers.set(`invoice:${inv.id}`, inv.invoiceNumber);
    for (const bill of outstandingBills ?? []) numbers.set(`bill:${bill.id}`, bill.billNumber);
    return numbers;
  }, [outstandingInvoices, outstandingBills]);

  /**
   * 参考号的缺省值：勾上的单据号。用户没动过参考号时，输入框里显示的就是
   * 它，随勾选变化；动过之后显示用户写的，清空了就作为占位提示露出来——
   * 留空提交时用的也是它。规则见 pick-document.ts 的 referenceFromDocuments。
   */
  const autoReference = referenceFromDocuments(selectedItems, (item: SelectedItem) =>
    item.invoiceId
      ? documentNumbers.get(`invoice:${item.invoiceId}`)
      : documentNumbers.get(`bill:${item.billId}`),
  );
  const shownReference = referenceEdited ? reference : autoReference;

  /** 点了快捷清单里的一张单据。规则见 pick-document.ts。 */
  function pick(doc: QuickPick) {
    const next = pickDocument(draft, doc);
    // 换了客户或币种，之前手填的总金额是给另一件事填的，留着只会让「挂账」
    // 那一截算错。同一位客户再加一张时保留。
    if (next.type !== paymentType || next.contactId !== contactId || next.currency !== currency) {
      setAmount('');
    }
    setPaymentType(next.type);
    setContactId(next.contactId);
    setCurrency(next.currency);
    setSelectedItems(next.selectedItems);
    setError(null);
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
  const visiblePicks = paymentType === 'received' ? quickPicks.invoices : quickPicks.bills;

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
    // 见 components/transactions/rate-field.tsx。
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
        method,
        moneyAccountId: moneyAccountId || undefined,
        reference: shownReference.trim() || autoReference || undefined,
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

      {/*
        快捷清单：全公司所有未结的发票（或账单），不分客户、不分币种。点一张，
        客户、币种、核销金额一起填好——不必先猜对客户、再把币种改对，下面的
        单据清单才肯列出来。按到期日排，逾期的标出来：先收最该收的那一笔。
      */}
      {visiblePicks.length > 0 ? (
        // 手机上不给这张清单内嵌滚动条（页面里再套一层滚动，拇指一滑就分不清
        // 在滚哪一层），改成先列前 5 张、其余收在「显示全部」后面；桌面上
        // 仍是固定高度的滚动清单，data-expanded 只在手机那一段里起作用。
        <section
          className="payment-quick-pick"
          aria-labelledby="quickPickTitle"
          data-expanded={showAllPicks || visiblePicks.length <= QUICK_PICK_PREVIEW || undefined}
        >
          <h2 id="quickPickTitle">
            {paymentType === 'received'
              ? i18n.payments.quickPickInvoices
              : i18n.payments.quickPickBills}
          </h2>
          <p className="field-hint">{i18n.payments.quickPickHint}</p>
          <ul>
            {visiblePicks.map((doc) => {
              const picked = isPicked(draft, doc);
              const overdue = doc.dueDate < today;
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    className="payment-quick-pick-item"
                    aria-pressed={picked}
                    onClick={() => pick(doc)}
                  >
                    <span className="payment-quick-pick-number mono">{doc.number}</span>
                    <span className="payment-quick-pick-contact">{doc.contactName}</span>
                    <span
                      className={
                        overdue ? 'payment-quick-pick-due is-overdue' : 'payment-quick-pick-due'
                      }
                    >
                      {overdue
                        ? interpolate(i18n.payments.overdueSince, { date: doc.dueDate })
                        : interpolate(i18n.payments.dueOn, { date: doc.dueDate })}
                    </span>
                    <span className="payment-quick-pick-amount mono">
                      {formatMoney(doc.remainingMinor, doc.currency)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!showAllPicks && visiblePicks.length > QUICK_PICK_PREVIEW ? (
            <button
              type="button"
              className="payment-quick-pick-more"
              onClick={() => setShowAllPicks(true)}
            >
              {interpolate(i18n.payments.showAllPicks, { count: String(visiblePicks.length) })}
            </button>
          ) : null}
        </section>
      ) : null}

      {/* 收款的对象是客户，付款的对象是供应商。原来两种都写「客户」。 */}
      <label htmlFor="contactId">
        {paymentType === 'received' ? i18n.invoices.customer : i18n.bills.vendor}
      </label>
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
      <select
        id="method"
        value={method}
        onChange={(e) => setMethod(e.target.value as PaymentMethod)}
      >
        {METHODS.map((m) => (
          <option key={m.value} value={m.value}>
            {i18n.payments[m.key]}
          </option>
        ))}
      </select>

      {/* 钱进出的是哪个户口。原来没有这一栏，非现金的收付款一律进系统自带
          的「银行」，公司有几个户口时，真正收到钱的那个余额不动、对账对不上。 */}
      <label htmlFor="moneyAccountId">
        {paymentType === 'received'
          ? i18n.payments.moneyAccountReceived
          : i18n.payments.moneyAccountMade}
      </label>
      <select
        id="moneyAccountId"
        value={moneyAccountId}
        onChange={(e) => setChosenMoneyAccountId(e.target.value)}
        aria-describedby="moneyAccountHint"
        required
      >
        {moneyAccounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </select>
      <p className="field-hint" id="moneyAccountHint">
        {i18n.payments.moneyAccountHint}
      </p>

      <label htmlFor="reference">{i18n.payments.reference}</label>
      <input
        id="reference"
        type="text"
        maxLength={MAX_PAYMENT_REFERENCE_LENGTH}
        value={shownReference}
        placeholder={autoReference}
        aria-describedby="referenceHint"
        onChange={(e) => {
          setReference(e.target.value);
          setReferenceEdited(true);
        }}
      />
      <p className="field-hint" id="referenceHint">
        {paymentType === 'received'
          ? i18n.payments.referenceHintInvoices
          : i18n.payments.referenceHintBills}
      </p>

      <fieldset className="payment-settlement" aria-describedby="settlementHint">
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
