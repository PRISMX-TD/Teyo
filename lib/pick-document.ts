import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';

/** 收付款表单上一张可以点选的未结单据。 */
export type PickableDocument = {
  id: string;
  kind: 'invoice' | 'bill';
  contactId: string;
  currency: string;
  remainingMinor: bigint;
};

export type SelectedItem = { invoiceId?: string; billId?: string; amount: string };

/** 表单里「点一张单据」会动到的那几项。 */
export type PaymentDraft = {
  type: 'received' | 'made';
  contactId: string;
  currency: string;
  selectedItems: SelectedItem[];
};

function isItemFor(item: SelectedItem, doc: PickableDocument): boolean {
  return doc.kind === 'invoice' ? item.invoiceId === doc.id : item.billId === doc.id;
}

/**
 * 点了一张未结单据之后，表单应该变成什么样。
 *
 * 一张单据自带了这笔款该填的一切：方向（发票是收款、账单是付款）、往来对象、
 * 币种、该核销多少。用户原来要自己把这几样一项项对上——选对客户、把币种
 * 从本位币改成发票的币种（不改的话下面一张单据都列不出来）、再去勾那一张。
 *
 *   - 与当前方向、往来对象、币种都相同：追加进核销清单（一笔钱付几张发票）；
 *     已经在清单里的，再点一次就是取消。
 *   - 任何一样不同：整张表切过去，核销清单只剩这一张。留着别的客户或别的
 *     币种的单据，服务端会拒，用户还看不出是哪一条的问题。
 *
 * 核销金额预填剩余未结额，按单据币种的小数位折算，不经浮点——理由同
 * payment-form.tsx 的 toggleItem。
 */
export function pickDocument(draft: PaymentDraft, doc: PickableDocument): PaymentDraft {
  const type = doc.kind === 'invoice' ? 'received' : 'made';
  const sameGroup =
    draft.type === type && draft.contactId === doc.contactId && draft.currency === doc.currency;

  if (sameGroup && draft.selectedItems.some((item) => isItemFor(item, doc))) {
    return { ...draft, selectedItems: draft.selectedItems.filter((item) => !isItemFor(item, doc)) };
  }

  const amount = formatMinorToDecimal(doc.remainingMinor, currencyExponent(doc.currency));
  const item: SelectedItem =
    doc.kind === 'invoice' ? { invoiceId: doc.id, amount } : { billId: doc.id, amount };

  return sameGroup
    ? { ...draft, selectedItems: [...draft.selectedItems, item] }
    : { type, contactId: doc.contactId, currency: doc.currency, selectedItems: [item] };
}

/**
 * 参考号的长度上限，与 server/actions/payments.ts 的 `reference` 校验
 * （z.string().max(200)）一致。
 */
export const MAX_PAYMENT_REFERENCE_LENGTH = 200;

/**
 * 参考号没填时用的那一串：勾上的单据的编号，按勾选的先后，逗号隔开。
 *
 * 参考号本来是给银行流水号、支票号的——那个系统拿不到。但留空的代价是
 * 收付款列表那一栏只有「-」、流水里只写「Customer receipt」、交易详情的
 * 来源只剩一个日期，谁也看不出这笔钱是哪张发票的。单据号是手边最好的
 * 替代。
 *
 * 没有编号的单据跳过：账单号可以为空，未结清单里把它显示成「—」，那不是
 * 一个号。勾得太多、超过长度上限时，留下放得下的前几个，后面写「+N」——
 * 截在半个编号上的参考号比没有更误导。
 */
export function referenceFromDocuments(
  items: SelectedItem[],
  numberOf: (item: SelectedItem) => string | undefined,
  maxLength: number = MAX_PAYMENT_REFERENCE_LENGTH,
): string {
  const numbers = items
    .map((item) => numberOf(item)?.trim() ?? '')
    .filter((number) => /[\p{L}\p{N}]/u.test(number));

  const all = numbers.join(', ');
  if (all.length <= maxLength) return all;

  for (let kept = numbers.length - 1; kept >= 1; kept--) {
    const shortened = `${numbers.slice(0, kept).join(', ')} +${numbers.length - kept}`;
    if (shortened.length <= maxLength) return shortened;
  }
  return numbers[0].slice(0, maxLength);
}

/** 这一张是否已经在核销清单里。 */
export function isPicked(draft: PaymentDraft, doc: PickableDocument): boolean {
  return draft.selectedItems.some((item) => isItemFor(item, doc));
}
