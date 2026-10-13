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

/** 这一张是否已经在核销清单里。 */
export function isPicked(draft: PaymentDraft, doc: PickableDocument): boolean {
  return draft.selectedItems.some((item) => isItemFor(item, doc));
}
