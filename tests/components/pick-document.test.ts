import { describe, expect, it } from 'vitest';
import {
  isPicked,
  pickDocument,
  type PaymentDraft,
  type PickableDocument,
} from '@/components/payments/pick-document';
import { hasBalanceToSettle } from '@/server/repositories/payments';

const EMPTY: PaymentDraft = {
  type: 'received',
  contactId: 'customer-a',
  currency: 'MYR',
  selectedItems: [],
};

function invoice(overrides: Partial<PickableDocument> = {}): PickableDocument {
  return {
    id: 'inv-1',
    kind: 'invoice',
    contactId: 'customer-b',
    currency: 'USD',
    remainingMinor: 100000n,
    ...overrides,
  };
}

describe('pickDocument', () => {
  it('fills in the customer, currency and remaining amount from the invoice', () => {
    // 表单原来停在第一位客户、本位币 MYR；发票是另一位客户的 USD——
    // 用户原来要自己把这两样改对，下面的单据清单才肯列出它。
    expect(pickDocument(EMPTY, invoice())).toEqual({
      type: 'received',
      contactId: 'customer-b',
      currency: 'USD',
      selectedItems: [{ invoiceId: 'inv-1', amount: '1000.00' }],
    });
  });

  it('switches to a payment made when a bill is picked', () => {
    const next = pickDocument(EMPTY, {
      id: 'bill-1',
      kind: 'bill',
      contactId: 'vendor-a',
      currency: 'MYR',
      remainingMinor: 4250n,
    });
    expect(next.type).toBe('made');
    expect(next.contactId).toBe('vendor-a');
    expect(next.selectedItems).toEqual([{ billId: 'bill-1', amount: '42.50' }]);
  });

  it('adds a second invoice from the same customer and currency to the same payment', () => {
    const first = pickDocument(EMPTY, invoice());
    const second = pickDocument(first, invoice({ id: 'inv-2', remainingMinor: 2500n }));
    expect(second.selectedItems).toEqual([
      { invoiceId: 'inv-1', amount: '1000.00' },
      { invoiceId: 'inv-2', amount: '25.00' },
    ]);
  });

  it('starts over when the next invoice is another customer’s or another currency', () => {
    const first = pickDocument(EMPTY, invoice());
    const otherCustomer = pickDocument(first, invoice({ id: 'inv-3', contactId: 'customer-c' }));
    expect(otherCustomer.contactId).toBe('customer-c');
    expect(otherCustomer.selectedItems).toEqual([{ invoiceId: 'inv-3', amount: '1000.00' }]);

    const otherCurrency = pickDocument(first, invoice({ id: 'inv-4', currency: 'MYR' }));
    expect(otherCurrency.currency).toBe('MYR');
    expect(otherCurrency.selectedItems).toEqual([{ invoiceId: 'inv-4', amount: '1000.00' }]);
  });

  it('takes an invoice back out when it is picked again', () => {
    const picked = pickDocument(EMPTY, invoice());
    expect(isPicked(picked, invoice())).toBe(true);
    const unpicked = pickDocument(picked, invoice());
    expect(unpicked.selectedItems).toEqual([]);
    expect(isPicked(unpicked, invoice())).toBe(false);
  });

  it('prefills in the currency’s own decimals', () => {
    const next = pickDocument(EMPTY, invoice({ currency: 'JPY', remainingMinor: 150000n }));
    expect(next.selectedItems).toEqual([{ invoiceId: 'inv-1', amount: '150000' }]);
  });
});

describe('hasBalanceToSettle', () => {
  const issued = { status: 'sent', voidedAt: null, totalMinor: 10000n };

  it('is true for an issued invoice with money still owed', () => {
    expect(hasBalanceToSettle(issued, 0n)).toBe(true);
    expect(hasBalanceToSettle({ ...issued, status: 'partially_paid' }, 4000n)).toBe(true);
    expect(hasBalanceToSettle({ ...issued, status: 'overdue' }, 0n)).toBe(true);
    expect(hasBalanceToSettle({ ...issued, status: 'received' }, 0n)).toBe(true);
  });

  it('is false for a draft, a voided or a fully settled document', () => {
    expect(hasBalanceToSettle({ ...issued, status: 'draft' }, 0n)).toBe(false);
    expect(hasBalanceToSettle({ ...issued, status: 'voided' }, 0n)).toBe(false);
    expect(hasBalanceToSettle({ ...issued, voidedAt: '2026-10-01T00:00:00Z' }, 0n)).toBe(false);
    expect(hasBalanceToSettle({ ...issued, status: 'paid' }, 10000n)).toBe(false);
    expect(hasBalanceToSettle(issued, 10000n)).toBe(false);
  });
});
