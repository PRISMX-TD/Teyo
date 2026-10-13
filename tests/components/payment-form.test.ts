import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock('@/server/actions/payments', () => ({ createPayment: async () => ({}) }));
vi.mock('@/server/actions/rates', () => ({ lookupRate: async () => null }));

const { PaymentForm } = await import('@/components/payments/payment-form');
const { getMessages } = await import('@/lib/i18n');

const zh = getMessages('zh');

const CONTACTS = [
  { id: 'c-alpha', name: 'Alpha Trading' },
  { id: 'c-make', name: 'Make Capital' },
  { id: 'c-paper', name: 'Paper Supplier' },
];

const INVOICES = [
  {
    id: 'inv-1',
    invoiceNumber: 'INV-00001',
    customerName: 'Make Capital',
    contactId: 'c-make',
    totalMinor: 100000n,
    paidMinor: 0n,
    currency: 'USD',
    dueDate: '2000-01-31',
  },
  {
    id: 'inv-2',
    invoiceNumber: 'INV-00002',
    customerName: 'Alpha Trading',
    contactId: 'c-alpha',
    totalMinor: 50000n,
    paidMinor: 20000n,
    currency: 'MYR',
    dueDate: '2999-12-31',
  },
];

const MONEY_ACCOUNTS = [
  { id: 'a-cash', code: 'cash', name: '现金' },
  { id: 'a-bank', code: 'bank', name: '银行' },
  { id: 'a-maybank', code: 'maybank', name: 'Maybank' },
];

const BILLS = [
  {
    id: 'bill-1',
    billNumber: 'B-001',
    vendorName: 'Paper Supplier',
    contactId: 'c-paper',
    totalMinor: 8000n,
    paidMinor: 0n,
    currency: 'MYR',
    dueDate: '2999-12-31',
  },
];

function render(
  initialDocument: { kind: 'invoice' | 'bill'; id: string } | null = null,
  moneyAccounts = MONEY_ACCOUNTS,
) {
  return renderToStaticMarkup(
    createElement(PaymentForm, {
      orgSlug: 'acme',
      locale: 'zh',
      i18n: zh,
      contacts: CONTACTS,
      type: 'received',
      currencies: ['MYR', 'USD', 'SGD'],
      baseCurrency: 'MYR',
      moneyAccounts,
      outstandingInvoices: INVOICES,
      outstandingBills: BILLS,
      initialDocument,
    }),
  );
}

/** 某个 <select> 当前选中的那一项。 */
function selected(html: string, id: string): string | undefined {
  const select = new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1];
  return select ? /<option[^>]*value="([^"]*)"[^>]*selected/.exec(select)?.[1] : undefined;
}

describe('PaymentForm', () => {
  it('lists every unpaid invoice, from every customer and currency, to pick from', () => {
    const html = render();
    expect(html).toContain(zh.payments.quickPickInvoices);
    expect(html).toContain('INV-00001');
    expect(html).toContain('INV-00002');
    // 剩余额，不是总额：INV-00002 已经收了 200。
    expect(html).toContain('RM 300.00');
    expect(html).toContain('US$ 1,000.00');
  });

  it('marks an overdue invoice', () => {
    const html = render();
    expect(html).toContain('已逾期（2000-01-31 到期）');
    expect(html).toContain('2999-12-31 到期');
  });

  it('opens already filled in when it comes from an invoice', () => {
    const html = render({ kind: 'invoice', id: 'inv-1' });
    expect(selected(html, 'contactId')).toBe('c-make');
    expect(selected(html, 'currency')).toBe('USD');
    // 那张发票已经勾上，核销金额是它的剩余额。
    expect(html).toMatch(/<input type="checkbox" checked=""/);
    expect(html).toContain('value="1000.00"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>[\s\S]*?INV-00001/);
  });

  it('opens as a payment made, against the bill, when it comes from a bill', () => {
    const html = render({ kind: 'bill', id: 'bill-1' });
    expect(html).toContain('<input type="radio" name="paymentType" checked="" value="made"/>');
    expect(selected(html, 'contactId')).toBe('c-paper');
    expect(html).toContain(zh.payments.quickPickBills);
    // 付款的对象是供应商，标签不再写「客户」。
    expect(html).toContain(`<label for="contactId">${zh.bills.vendor}</label>`);
  });

  it('fills the reference in with the invoice number', () => {
    const html = render({ kind: 'invoice', id: 'inv-1' });
    expect(html).toMatch(/<input id="reference"[^>]*value="INV-00001"/);
    expect(html).toContain(zh.payments.referenceHintInvoices);
  });

  it('fills the reference in with the bill number on a payment made', () => {
    const html = render({ kind: 'bill', id: 'bill-1' });
    expect(html).toMatch(/<input id="reference"[^>]*value="B-001"/);
    expect(html).toContain(zh.payments.referenceHintBills);
  });

  it('leaves the reference empty until a document is ticked', () => {
    const html = render();
    expect(html).toMatch(/<input id="reference"[^>]*value=""/);
  });

  it('offers every money account, defaulting to the bank for a bank transfer', () => {
    const html = render();
    expect(html).toContain(`<label for="moneyAccountId">${zh.payments.moneyAccountReceived}</label>`);
    expect(html).toContain('>Maybank</option>');
    expect(selected(html, 'moneyAccountId')).toBe('a-bank');
  });

  it('calls it the account paid from on a payment made', () => {
    const html = render({ kind: 'bill', id: 'bill-1' });
    expect(html).toContain(`<label for="moneyAccountId">${zh.payments.moneyAccountMade}</label>`);
  });

  it('does not default to an archived built-in bank', () => {
    // 停用的账户不会传进来；缺省落到第一个不是现金的户口上。
    const html = render(null, MONEY_ACCOUNTS.filter((account) => account.code !== 'bank'));
    expect(selected(html, 'moneyAccountId')).toBe('a-maybank');
  });

  it('ignores a document it was not given', () => {
    const html = render({ kind: 'invoice', id: 'not-outstanding' });
    expect(selected(html, 'currency')).toBe('MYR');
    expect(html).not.toMatch(/aria-pressed="true"/);
  });
});
