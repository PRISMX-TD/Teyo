import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createInvoice } = await import('@/server/actions/invoices');
const { createPayment } = await import('@/server/actions/payments');
const { listOutstandingDocuments } = await import('@/server/repositories/payments');
const { withTransaction } = await import('@/server/db/transaction');

/**
 * 收付款页的快捷清单与发票页的「记录收款」按钮都靠这份清单：
 * 要有到期日（排序、标逾期），要排除草稿，余额要扣掉已收的。
 */

let ownerId: string;
let orgId: string;
let orgSlug: string;
let customerId: string;

const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  ownerId = await createTestUser(`owner-outst-${suffix}@example.com`, 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Outstanding Co', `outst-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  const [contact] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'customer', 'Slow Payer')
    returning id
  `;
  customerId = contact.id as string;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

async function invoice(issue: boolean, dueDate: string) {
  currentUserId = ownerId;
  const { id } = await createInvoice(orgSlug, {
    contactId: customerId,
    issueDate: '2033-06-01',
    dueDate,
    currency: 'MYR',
    taxRatePercent: '0',
    items: [{ description: 'Work', quantity: '1', unitPrice: '300.00' }],
    issue,
  });
  return id;
}

async function outstanding() {
  return withTransaction(ownerId, (tx) => listOutstandingDocuments(tx, orgId));
}

describe('listOutstandingDocuments', () => {
  it('gives each issued invoice its due date and leaves drafts out', async () => {
    const issued = await invoice(true, '2033-07-01');
    const draft = await invoice(false, '2033-07-02');

    const docs = await outstanding();
    expect(docs.find((doc) => doc.id === issued)).toMatchObject({
      kind: 'invoice',
      contactId: customerId,
      contactName: 'Slow Payer',
      currency: 'MYR',
      remainingMinor: 30000n,
      dueDate: '2033-07-01',
    });
    expect(docs.some((doc) => doc.id === draft)).toBe(false);
  });

  it('orders by due date, soonest first', async () => {
    const later = await invoice(true, '2033-09-30');
    const sooner = await invoice(true, '2033-06-15');
    const ids = (await outstanding()).map((doc) => doc.id);
    expect(ids.indexOf(sooner)).toBeLessThan(ids.indexOf(later));
  });

  it('shows what is left after a part payment, and drops the invoice once it is paid', async () => {
    const id = await invoice(true, '2033-08-01');
    const pay = (amount: string) =>
      createPayment(orgSlug, {
        contactId: customerId,
        type: 'received',
        amount,
        currency: 'MYR',
        paymentDate: '2033-06-10',
        method: 'bank_transfer',
        items: [{ invoiceId: id, amount }],
      });

    await pay('100.00');
    expect((await outstanding()).find((doc) => doc.id === id)?.remainingMinor).toBe(20000n);

    await pay('200.00');
    expect((await outstanding()).some((doc) => doc.id === id)).toBe(false);
  });
});
