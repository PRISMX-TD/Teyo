import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { getBill } from '@/server/repositories/bills';
import { getInvoice } from '@/server/repositories/invoices';
import { getPurchaseOrder } from '@/server/repositories/purchase-orders';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
} from '@/tests/helpers/test-db';

/**
 * ⚠ 整个文件依赖迁移 0031（bills.purchase_order_id 与四张明细表的 position）。
 * 0031 执行之前，每一条会建单据的用例都会以 `column "position" ... does not
 * exist` 失败——代码已经按目标形态写好、库还没跟上的中间态，同
 * bills-posting.test.ts 顶部那段说明。
 */

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createBill, updateBill, voidBill } = await import('@/server/actions/bills');
const { createInvoice } = await import('@/server/actions/invoices');
const { createPurchaseOrder, setPoStatusAction } = await import(
  '@/server/actions/purchase-orders'
);

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let bookkeeperId: string;
let orgId: string;
let orgSlug: string;
let vendorId: string;
let otherVendorId: string;
let customerId: string;

/** 本位币 MYR、单据也是 MYR：不碰 exchange_rates，日期随便取一格没人用的。 */
const DAY = '2033-03-10';
const DUE = '2033-04-10';

/** 2 × 150.00 = 300.00，外加 1 × 50.00。采购单合计 350.00。 */
const PO_LINES = [
  { description: 'Widget', quantity: 2, unitPriceMinor: '15000' },
  { description: 'Freight', quantity: 1, unitPriceMinor: '5000' },
];

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-pobill-${suffix}@example.com`, 'Owner');
  bookkeeperId = await createTestUser(`test-book-pobill-${suffix}@example.com`, 'Bookkeeper');

  const org = await createTestOrgWithSeed(ownerId, 'PO Bill Co', `po-bill-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  await joinOrg(bookkeeperId, orgId, 'bookkeeper');

  const [vendor] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'vendor', 'Acme Supplies')
    returning id
  `;
  vendorId = vendor.id as string;

  const [other] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'vendor', 'Other Supplies')
    returning id
  `;
  otherVendorId = other.id as string;

  const [customer] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'customer', 'Line Order Customer')
    returning id
  `;
  customerId = customer.id as string;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

/** 建一张采购单并推到给定状态（draft 就不动）。 */
async function poIn(status: 'draft' | 'sent' | 'received'): Promise<string> {
  currentUserId = ownerId;
  const { id } = await createPurchaseOrder(orgSlug, {
    contactId: vendorId,
    issueDate: DAY,
    currency: 'MYR',
    items: PO_LINES,
  });
  if (status !== 'draft') await setPoStatusAction(orgSlug, id, status);
  return id;
}

/** 照 bills/new?fromPo= 那张预填表单提交的形状。 */
function billFromPo(purchaseOrderId: string, overrides: Record<string, unknown> = {}) {
  return {
    contactId: vendorId,
    issueDate: DAY,
    dueDate: DUE,
    currency: 'MYR',
    items: [
      { description: 'Widget', amount: '300.00' },
      { description: 'Freight', amount: '50.00' },
    ],
    purchaseOrderId,
    ...overrides,
  };
}

async function poStatus(id: string): Promise<string> {
  const [row] = await admin`select status from purchase_orders where id = ${id}`;
  return row.status as string;
}

async function billsForPo(id: string) {
  return admin`
    select id, status, voided_at from bills where purchase_order_id = ${id} order by created_at
  `;
}

describe('采购单转账单', () => {
  it('建出一张已过账、链回采购单的账单，金额与采购单一致，采购单变成 billed', async () => {
    const poId = await poIn('sent');

    // 记账员有 transaction:create，转账单是他的日常工作。
    currentUserId = bookkeeperId;
    const { id, transactionId } = await createBill(orgSlug, billFromPo(poId));
    expect(transactionId).not.toBeNull();

    const [row] = await admin`
      select status, purchase_order_id, subtotal_minor, total_minor, transaction_id
      from bills where id = ${id}
    `;
    expect(row.status).toBe('received');
    expect(row.purchase_order_id).toBe(poId);
    expect(row.transaction_id).toBe(transactionId);

    const [poTotal] = await admin`
      select sum(amount_minor)::text as total from po_items where po_id = ${poId}
    `;
    expect(row.subtotal_minor).toBe(poTotal.total);
    expect(row.total_minor).toBe('35000');

    // 过账与手工录的账单一模一样：借采购 / 贷应付，金额为账单总额。
    const [txn] = await admin`
      select amount_minor, voided_at from transactions where id = ${transactionId}
    `;
    expect(txn.amount_minor).toBe('35000');
    expect(txn.voided_at).toBeNull();
    const lines = await admin`
      select direction, amount_minor from journal_lines
      where transaction_id = ${transactionId}
      order by direction
    `;
    expect(lines.map((l) => [l.direction, l.amount_minor])).toEqual([
      ['debit', '35000'],
      ['credit', '35000'],
    ]);

    expect(await poStatus(poId)).toBe('billed');

    const detail = await withTransaction(ownerId, (tx) => getBill(tx, orgId, id));
    expect(detail?.purchaseOrderId).toBe(poId);
    const po = await withTransaction(ownerId, (tx) => getPurchaseOrder(tx, orgId, poId));
    expect(detail?.purchaseOrderNumber).toBe(po?.poNumber);

    const audit = await admin`
      select action, before->>'status' as before_status from audit_logs
      where entity_id = ${poId} and action = 'purchase_order.billed'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0].before_status).toBe('sent');
  });

  it('同一张采购单不能转两次', async () => {
    const poId = await poIn('received');
    currentUserId = ownerId;
    await createBill(orgSlug, billFromPo(poId));

    await expect(createBill(orgSlug, billFromPo(poId))).rejects.toThrow(/billed|already/);
    expect(await billsForPo(poId)).toHaveLength(1);
  });

  it('草稿、作废、已关单的采购单不能转', async () => {
    const draftId = await poIn('draft');
    currentUserId = ownerId;
    await expect(createBill(orgSlug, billFromPo(draftId))).rejects.toThrow(/draft/);

    const voidedId = await poIn('sent');
    await setPoStatusAction(orgSlug, voidedId, 'voided');
    await expect(createBill(orgSlug, billFromPo(voidedId))).rejects.toThrow(/voided/);

    const closedId = await poIn('received');
    await setPoStatusAction(orgSlug, closedId, 'closed');
    await expect(createBill(orgSlug, billFromPo(closedId))).rejects.toThrow(/closed/);

    // 被拒的转换一个字节都不写：没有账单，也没有分录。
    for (const id of [draftId, voidedId, closedId]) {
      expect(await billsForPo(id)).toHaveLength(0);
    }
  });

  it('供应商或币种与采购单不一致时拒绝', async () => {
    const poId = await poIn('sent');
    currentUserId = ownerId;

    await expect(
      createBill(orgSlug, billFromPo(poId, { contactId: otherVendorId })),
    ).rejects.toThrow(/same vendor/);
    await expect(
      createBill(orgSlug, billFromPo(poId, { currency: 'USD' })),
    ).rejects.toThrow(/currency/);

    expect(await billsForPo(poId)).toHaveLength(0);
    expect(await poStatus(poId)).toBe('sent');
  });

  it('已转出的账单不能改供应商', async () => {
    const poId = await poIn('sent');
    currentUserId = ownerId;
    const { id } = await createBill(orgSlug, billFromPo(poId));

    const { purchaseOrderId: _ignored, ...edit } = billFromPo(poId, { contactId: otherVendorId });
    await expect(updateBill(orgSlug, id, edit)).rejects.toThrow(/vendor and currency/);
  });

  it('另一家公司的采购单拿不来转', async () => {
    const strangerId = await createTestUser(`test-stranger-pobill-${suffix}@example.com`, 'S');
    const otherOrg = await createTestOrgWithSeed(
      strangerId,
      'Other PO Co',
      `other-po-co-${suffix}`,
      'MYR',
    );
    const [otherVendor] = await admin`
      insert into contacts (organization_id, type, name)
      values (${otherOrg.id}, 'vendor', 'Foreign Vendor')
      returning id
    `;
    currentUserId = strangerId;
    const { id: foreignPo } = await createPurchaseOrder(otherOrg.slug, {
      contactId: otherVendor.id as string,
      issueDate: DAY,
      currency: 'MYR',
      items: PO_LINES,
    });
    await setPoStatusAction(otherOrg.slug, foreignPo, 'sent');

    currentUserId = ownerId;
    await expect(createBill(orgSlug, billFromPo(foreignPo))).rejects.toThrow(/not found/);
    expect(await poStatus(foreignPo)).toBe('sent');
  });
});

describe('作废转出的账单', () => {
  it('采购单退回转账单之前的状态，并且可以再转一次', async () => {
    const sentPo = await poIn('sent');
    const receivedPo = await poIn('received');
    currentUserId = ownerId;

    const { id: first } = await createBill(orgSlug, billFromPo(sentPo));
    const { id: second } = await createBill(orgSlug, billFromPo(receivedPo));

    await voidBill(orgSlug, first, 'Vendor sent the wrong invoice');
    await voidBill(orgSlug, second, 'Duplicate');

    // 不臆造「已收货」：sent 的回到 sent，received 的回到 received。
    expect(await poStatus(sentPo)).toBe('sent');
    expect(await poStatus(receivedPo)).toBe('received');

    // 作废的那张保留链接（它确实是从这张采购单转出来的），但不再算「已转过」。
    const [voided] = await admin`select purchase_order_id, voided_at from bills where id = ${first}`;
    expect(voided.purchase_order_id).toBe(sentPo);
    expect(voided.voided_at).not.toBeNull();

    const { id: again } = await createBill(orgSlug, billFromPo(sentPo));
    expect(await poStatus(sentPo)).toBe('billed');
    const linked = await billsForPo(sentPo);
    expect(linked.map((b) => b.id)).toEqual([first, again]);

    const reopened = await admin`
      select after->>'status' as status from audit_logs
      where entity_id = ${sentPo} and action = 'purchase_order.reopened'
    `;
    expect(reopened.map((r) => r.status)).toEqual(['sent']);
  });

  it('已关单的采购单不因账单作废而重新打开', async () => {
    const poId = await poIn('received');
    currentUserId = ownerId;
    const { id } = await createBill(orgSlug, billFromPo(poId));
    await setPoStatusAction(orgSlug, poId, 'closed');

    await voidBill(orgSlug, id, 'Wrong amount');
    expect(await poStatus(poId)).toBe('closed');
  });
});

describe('明细行序', () => {
  // 八行，id 是随机 uuid：按 id 排出来恰好是录入顺序的概率是 1/8!。
  const DESCRIPTIONS = ['H', 'C', 'F', 'A', 'G', 'B', 'E', 'D'];

  it('发票按提交顺序读回', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, {
      contactId: customerId,
      issueDate: DAY,
      dueDate: DUE,
      currency: 'MYR',
      taxRatePercent: '0',
      items: DESCRIPTIONS.map((description, i) => ({
        description,
        quantity: '1',
        unitPrice: `${i + 1}.00`,
      })),
    });

    const invoice = await withTransaction(ownerId, (tx) => getInvoice(tx, orgId, id));
    expect(invoice?.items.map((item) => item.description)).toEqual(DESCRIPTIONS);

    const positions = await admin`
      select description, position from invoice_items where invoice_id = ${id}
      order by position
    `;
    expect(positions.map((row) => row.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('账单按提交顺序读回，编辑重排之后按新顺序读回', async () => {
    currentUserId = ownerId;
    const items = DESCRIPTIONS.map((description, i) => ({ description, amount: `${i + 1}.00` }));
    const { id } = await createBill(orgSlug, {
      contactId: vendorId,
      issueDate: DAY,
      dueDate: DUE,
      currency: 'MYR',
      items,
    });

    const bill = await withTransaction(ownerId, (tx) => getBill(tx, orgId, id));
    expect(bill?.items.map((item) => item.description)).toEqual(DESCRIPTIONS);

    const reversed = [...items].reverse();
    await updateBill(orgSlug, id, {
      contactId: vendorId,
      issueDate: DAY,
      dueDate: DUE,
      currency: 'MYR',
      items: reversed,
    });

    const edited = await withTransaction(ownerId, (tx) => getBill(tx, orgId, id));
    expect(edited?.items.map((item) => item.description)).toEqual(
      reversed.map((item) => item.description),
    );
  });

  it('采购单按提交顺序读回', async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(orgSlug, {
      contactId: vendorId,
      issueDate: DAY,
      currency: 'MYR',
      items: DESCRIPTIONS.map((description) => ({
        description,
        quantity: 1,
        unitPriceMinor: '100',
      })),
    });

    const po = await withTransaction(ownerId, (tx) => getPurchaseOrder(tx, orgId, id));
    expect(po?.items.map((item) => item.description)).toEqual(DESCRIPTIONS);
  });
});
