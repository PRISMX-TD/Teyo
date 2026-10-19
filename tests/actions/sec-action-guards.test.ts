// Server Action 入口的几道闸：往来对象的公司归属、账单状态白名单、
// 已付款账单不能换供应商、默认税率不会被一个不存在的 id 清空、定期规则
// 的入参与审计，以及页面层的权限不足落到 404 而不是错误页。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { createTestOrgWithSeed, createTestUser, joinOrg, resetTestData } from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createInvoice } = await import('@/server/actions/invoices');
const { createBill, updateBill } = await import('@/server/actions/bills');
const { createPayment } = await import('@/server/actions/payments');
const { createProject } = await import('@/server/actions/projects');
const { createTaxRate, setDefaultTaxRateAction } = await import('@/server/actions/tax');
const { createRecurring, editRecurring } = await import('@/server/actions/recurring');
const { requirePagePermission } = await import('@/server/auth/guard');

const suffix = randomUUID().slice(0, 8);
const DAY = '2033-04-10';
const DUE = '2033-05-10';

let ownerId: string;
let viewerId: string;
let orgA: { id: string; slug: string; accountsByCode: Record<string, string> };
let orgB: { id: string; slug: string };
let vendorA: string;
let otherVendorA: string;
let customerB: string;

async function insertContact(orgId: string, type: string, name: string): Promise<string> {
  const [row] = await admin`
    insert into contacts (organization_id, type, name) values (${orgId}, ${type}, ${name})
    returning id
  `;
  return row.id as string;
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-guards-owner-${suffix}@example.com`, 'Owner');
  viewerId = await createTestUser(`test-guards-viewer-${suffix}@example.com`, 'Viewer');
  orgA = await createTestOrgWithSeed(ownerId, 'Guards A', `guards-a-${suffix}`, 'MYR');
  orgB = await createTestOrgWithSeed(ownerId, 'Guards B', `guards-b-${suffix}`, 'MYR');
  await joinOrg(viewerId, orgA.id, 'viewer');

  vendorA = await insertContact(orgA.id, 'vendor', 'Vendor A');
  otherVendorA = await insertContact(orgA.id, 'vendor', 'Other vendor A');
  customerB = await insertContact(orgB.id, 'customer', 'Customer of B');

  currentUserId = ownerId;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('a contact from another company is refused', () => {
  it('on an invoice, and nothing is written', async () => {
    await expect(
      createInvoice(orgA.slug, {
        contactId: customerB,
        issueDate: DAY,
        dueDate: DUE,
        items: [{ description: 'Work', quantity: '1', unitPrice: '10.00' }],
        issue: true,
      }),
    ).rejects.toThrow(/contact was not found/i);

    const rows = await admin`select id from invoices where organization_id = ${orgA.id}`;
    expect(rows).toHaveLength(0);
  });

  it('on a bill', async () => {
    await expect(
      createBill(orgA.slug, {
        contactId: customerB,
        issueDate: DAY,
        dueDate: DUE,
        items: [{ description: 'Stock', amount: '10.00' }],
      }),
    ).rejects.toThrow(/contact was not found/i);
  });

  it('on a payment that settles nothing (a pure deposit)', async () => {
    await expect(
      createPayment(orgA.slug, {
        contactId: customerB,
        type: 'received',
        amount: '50.00',
        currency: 'MYR',
        paymentDate: DAY,
      }),
    ).rejects.toThrow(/contact was not found/i);
  });

  it('on a project', async () => {
    await expect(
      createProject(orgA.slug, { name: 'Leaky project', contactId: customerB }),
    ).rejects.toThrow(/contact was not found/i);
  });
});

describe('bills', () => {
  it('refuses a status other than draft or received', async () => {
    await expect(
      createBill(orgA.slug, {
        contactId: vendorA,
        issueDate: DAY,
        dueDate: DUE,
        items: [{ description: 'Stock', amount: '10.00' }],
        status: 'paid' as 'received',
      }),
    ).rejects.toThrow();

    const rows = await admin`
      select id from bills where organization_id = ${orgA.id} and status = 'paid'
    `;
    expect(rows).toHaveLength(0);
  });

  it('refuses a date that is not on the calendar', async () => {
    await expect(
      createBill(orgA.slug, {
        contactId: vendorA,
        issueDate: '2033-02-30',
        dueDate: DUE,
        items: [{ description: 'Stock', amount: '10.00' }],
      }),
    ).rejects.toThrow(/does not exist on the calendar/i);
  });

  it('cannot move a bill that already has payments to another vendor', async () => {
    const bill = await createBill(orgA.slug, {
      contactId: vendorA,
      issueDate: DAY,
      dueDate: DUE,
      currency: 'MYR',
      items: [{ description: 'Stock', amount: '100.00' }],
    });
    await createPayment(orgA.slug, {
      contactId: vendorA,
      type: 'made',
      amount: '40.00',
      currency: 'MYR',
      paymentDate: DAY,
      items: [{ billId: bill.id, amount: '40.00' }],
    });

    await expect(
      updateBill(orgA.slug, bill.id, {
        contactId: otherVendorA,
        issueDate: DAY,
        dueDate: DUE,
        currency: 'MYR',
        items: [{ description: 'Stock', amount: '100.00' }],
      }),
    ).rejects.toThrow(/vendor cannot be changed/i);

    const [row] = await admin`select contact_id from bills where id = ${bill.id}`;
    expect(row.contact_id).toBe(vendorA);
  });
});

describe('setDefaultTaxRateAction', () => {
  it('does not clear the current default when the id is not in this company', async () => {
    const { id } = await createTaxRate(orgA.slug, {
      nameEn: 'SST',
      nameZh: '销售税',
      rateBps: 600,
      isDefault: true,
    });

    await expect(setDefaultTaxRateAction(orgA.slug, randomUUID())).rejects.toThrow(/not found/i);

    const [row] = await admin`select is_default from tax_rates where id = ${id}`;
    expect(row.is_default).toBe(true);
  });
});

describe('recurring rules', () => {
  it('refuses an unknown frequency on create', async () => {
    await expect(
      createRecurring(orgA.slug, {
        kind: 'expense',
        description: 'Rent',
        amount: '100.00',
        currency: 'MYR',
        debitAccountId: orgA.accountsByCode.rent,
        creditAccountId: orgA.accountsByCode.bank,
        frequency: 'fortnightly' as 'monthly',
        interval: 1,
        startDate: DAY,
      }),
    ).rejects.toThrow();
  });

  it('refuses an end date before the start date', async () => {
    await expect(
      createRecurring(orgA.slug, {
        kind: 'expense',
        description: 'Rent',
        amount: '100.00',
        currency: 'MYR',
        debitAccountId: orgA.accountsByCode.rent,
        creditAccountId: orgA.accountsByCode.bank,
        frequency: 'monthly',
        interval: 1,
        startDate: DAY,
        endDate: '2033-01-01',
      }),
    ).rejects.toThrow(/end date/i);
  });

  it('writes an audit entry when a rule is edited', async () => {
    const { id } = await createRecurring(orgA.slug, {
      kind: 'expense',
      description: 'Rent',
      amount: '100.00',
      currency: 'MYR',
      debitAccountId: orgA.accountsByCode.rent,
      creditAccountId: orgA.accountsByCode.bank,
      frequency: 'monthly',
      interval: 1,
      startDate: DAY,
    });

    await editRecurring(orgA.slug, id, { amount: '120.00', currency: 'MYR' });

    const rows = await admin`
      select after from audit_logs
      where organization_id = ${orgA.id} and entity_id = ${id} and action = 'recurring.updated'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toMatchObject({ amount: '120.00', currency: 'MYR' });
  });
});

describe('requirePagePermission', () => {
  it('renders the company 404 for a role that lacks the permission', async () => {
    currentUserId = viewerId;
    try {
      await expect(requirePagePermission(orgA.slug, 'account:manage')).rejects.toMatchObject({
        digest: expect.stringMatching(/404|NOT_FOUND/),
      });
    } finally {
      currentUserId = ownerId;
    }
  });

  it('returns the context when the role has the permission', async () => {
    currentUserId = viewerId;
    try {
      const context = await requirePagePermission(orgA.slug, 'transaction:read');
      expect(context.role).toBe('viewer');
    } finally {
      currentUserId = ownerId;
    }
  });
});
