import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  resetTestData,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createTransaction, createJournal, updateTransaction, voidTransaction } = await import(
  '@/server/actions/transactions'
);
const { createInvoice, issueInvoice, voidInvoice } = await import('@/server/actions/invoices');
const { createBill, voidBill } = await import('@/server/actions/bills');
const { findTransactionSource } = await import('@/server/repositories/transactions');
const { voidDocumentPosting } = await import('@/server/services/document-posting');
const { requirePermission } = await import('@/server/auth/guard');

/**
 * 0031（fixed_assets.disposal_transaction_id、bills.purchase_order_id、
 * invoice_items.position……）可能还没跑到测试库。发票与账单的仓储已经在
 * 读写 0031 的列，缺列时 createInvoice / createBill 直接 42703。所以：
 *
 *   - 拦截本身的用例不走单据 Action，直接用 SQL 插一张指向手工凭证的
 *     发票 / 账单——闸只看「有没有单据指着这笔交易」，与单据怎么建无关；
 *   - 「单据自己的作废仍然可用」先用 voidDocumentPosting 证明（各单据的作废
 *     都走它，不依赖 0031），再在 0031 已落地时补一遍完整的
 *     createInvoice → issueInvoice → voidInvoice / createBill → voidBill；
 *   - 资产处置那一条只在有这一列时跑（findTransactionSource 对这一列的读取
 *     在缺列时不会报错，见该函数的注释）。
 */
const [disposalColumn] = await admin`
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'fixed_assets'
    and column_name = 'disposal_transaction_id'
`;
const has0031 = !!disposalColumn;

let ownerId: string;
let orgId: string;
let orgSlug: string;
let cashId: string;
let bankId: string;
let rentCategoryId: string;
let customerId: string;
let vendorId: string;
let assetId: string;

const suffix = randomUUID().slice(0, 8);

/** exchange_rates 是全局共享表，各文件靠日期错开；本位币记账其实用不到汇率。 */
const DAY = '2034-03-10';
const DUE = '2034-04-10';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-src-${suffix}@example.com`, 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Source Co', `source-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  cashId = org.accountsByCode.cash;
  bankId = org.accountsByCode.bank;
  rentCategoryId = org.categoriesByAccountCode.rent;

  const [customer] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'customer', 'Source Customer') returning id
  `;
  customerId = customer.id as string;
  const [vendor] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'vendor', 'Source Vendor') returning id
  `;
  vendorId = vendor.id as string;

  // 科目只需满足外键，折旧与处置的分录都由测试自己挂上去。
  const [asset] = await admin`
    insert into fixed_assets (organization_id, name, purchase_date, cost_minor, useful_life_months,
                              asset_account_id, depn_expense_account_id, depn_accum_account_id)
    values (${orgId}, 'Source Laptop', ${DAY}, 100000, 36, ${cashId}, ${cashId}, ${cashId})
    returning id
  `;
  assetId = asset.id as string;
});

afterAll(async () => {
  await admin`delete from fixed_assets where organization_id = ${orgId}`;
  await resetTestData();
  await admin.end();
});

/** 一张「已开具」的发票，分录是一笔手工凭证——只为让它指着这笔交易。 */
async function linkedInvoice() {
  const transactionId = await newManualJournal();
  const number = `INV-SRC-${randomUUID().slice(0, 6)}`;
  const [row] = await admin`
    insert into invoices (organization_id, contact_id, invoice_number, status, issue_date,
                          due_date, currency, subtotal_minor, total_minor, transaction_id)
    values (${orgId}, ${customerId}, ${number}, 'sent', ${DAY}, ${DUE}, 'MYR', 1000, 1000,
            ${transactionId})
    returning id
  `;
  return { id: row.id as string, transactionId, number };
}

async function linkedBill() {
  const transactionId = await newManualJournal();
  const number = `BILL-SRC-${randomUUID().slice(0, 6)}`;
  const [row] = await admin`
    insert into bills (organization_id, contact_id, bill_number, status, issue_date,
                       due_date, currency, subtotal_minor, total_minor, transaction_id)
    values (${orgId}, ${vendorId}, ${number}, 'received', ${DAY}, ${DUE}, 'MYR', 1000, 1000,
            ${transactionId})
    returning id
  `;
  return { id: row.id as string, transactionId, number };
}

async function newIssuedInvoice() {
  currentUserId = ownerId;
  const { id } = await createInvoice(orgSlug, {
    contactId: customerId,
    issueDate: DAY,
    dueDate: DUE,
    currency: 'MYR',
    taxRatePercent: '0',
    items: [{ description: 'Consulting', quantity: '1', unitPrice: '100.00' }],
  });
  const { transactionId } = await issueInvoice(orgSlug, id);
  const [row] = await admin`select invoice_number from invoices where id = ${id}`;
  return { id, transactionId, number: row.invoice_number as string };
}

async function newBill() {
  currentUserId = ownerId;
  const { id, transactionId } = await createBill(orgSlug, {
    contactId: vendorId,
    issueDate: DAY,
    dueDate: DUE,
    currency: 'MYR',
    items: [{ description: 'Stock purchase', amount: '100.00' }],
  });
  return { id, transactionId: transactionId as string };
}

async function newManualJournal() {
  currentUserId = ownerId;
  const { id } = await createJournal(orgSlug, {
    occurredOn: DAY,
    amount: '10.00',
    debitAccountId: cashId,
    creditAccountId: bankId,
    clientUuid: randomUUID(),
  });
  return id;
}

function editInput() {
  return {
    occurredOn: DAY,
    amount: '1.00',
    currency: 'MYR',
    moneyAccountId: cashId,
    categoryId: '',
    description: 'Tampered',
  };
}

async function isVoided(transactionId: string) {
  const [row] = await admin`select voided_at from transactions where id = ${transactionId}`;
  return row.voided_at !== null;
}

async function sourceOf(transactionId: string) {
  return admin.begin((tx) => findTransactionSource(tx as never, orgId, transactionId));
}

describe('findTransactionSource', () => {
  it('names the invoice that generated an entry', async () => {
    const invoice = await linkedInvoice();
    expect(await sourceOf(invoice.transactionId)).toEqual({
      type: 'invoice',
      id: invoice.id,
      label: invoice.number,
    });
  });

  it('returns null for a manual entry', async () => {
    expect(await sourceOf(await newManualJournal())).toBeNull();
  });

  /** 另一家公司的视角下，这张发票不存在。 */
  it('is scoped to the company', async () => {
    const invoice = await linkedInvoice();
    const source = await admin.begin((tx) =>
      findTransactionSource(tx as never, randomUUID(), invoice.transactionId),
    );
    expect(source).toBeNull();
  });
});

describe('generic void / edit refuse document-generated entries', () => {
  it('refuses to void or edit an invoice entry', async () => {
    const invoice = await linkedInvoice();

    currentUserId = ownerId;
    await expect(voidTransaction(orgSlug, invoice.transactionId, 'Oops')).rejects.toThrow(
      new RegExp(`generated by invoice ${invoice.number}`, 'i'),
    );
    await expect(updateTransaction(orgSlug, invoice.transactionId, editInput())).rejects.toThrow(
      /generated by invoice/i,
    );
    expect(await isVoided(invoice.transactionId)).toBe(false);
  });

  it('refuses to void or edit a bill entry', async () => {
    const bill = await linkedBill();

    currentUserId = ownerId;
    await expect(voidTransaction(orgSlug, bill.transactionId, 'Oops')).rejects.toThrow(
      /generated by bill/i,
    );
    await expect(updateTransaction(orgSlug, bill.transactionId, editInput())).rejects.toThrow(
      /generated by bill/i,
    );
    expect(await isVoided(bill.transactionId)).toBe(false);
  });

  /**
   * 闸只在面向用户的通用 Action 里。各单据的作废（voidInvoice、voidBill、
   * 收付款、贷项通知单）走的都是 voidDocumentPosting → markVoided，必须照常
   * 作废同一笔分录。
   */
  it('leaves the shared document void path untouched', async () => {
    const invoice = await linkedInvoice();

    currentUserId = ownerId;
    const context = await requirePermission(orgSlug, 'transaction:edit:any');
    await admin.begin(async (tx) => {
      await tx`select set_config('app.current_org_id', ${orgId}, true)`;
      await voidDocumentPosting(tx as never, context, {
        transactionId: invoice.transactionId,
        reason: 'Voided with the invoice',
      });
    });
    expect(await isVoided(invoice.transactionId)).toBe(true);
  });

  it.skipIf(!has0031)('voidInvoice / voidBill still void their entries (needs 0031)', async () => {
    const invoice = await newIssuedInvoice();
    const bill = await newBill();

    currentUserId = ownerId;
    await expect(voidTransaction(orgSlug, invoice.transactionId, 'Oops')).rejects.toThrow(
      /generated by invoice/i,
    );
    await expect(voidTransaction(orgSlug, bill.transactionId, 'Oops')).rejects.toThrow(
      /generated by bill/i,
    );

    await voidInvoice(orgSlug, invoice.id, 'Issued by mistake');
    await voidBill(orgSlug, bill.id, 'Duplicate bill');
    expect(await isVoided(invoice.transactionId)).toBe(true);
    expect(await isVoided(bill.transactionId)).toBe(true);
  });

  it('refuses to void a posted depreciation entry', async () => {
    const transactionId = await newManualJournal();
    await admin`
      insert into depreciation_schedules
        (fixed_asset_id, period, depreciation_minor, accumulated_minor, book_value_minor,
         is_posted, transaction_id)
      values (${assetId}, '2034-03-01', 1000, 1000, 99000, true, ${transactionId})
    `;

    expect(await sourceOf(transactionId)).toEqual({
      type: 'depreciation',
      id: assetId,
      label: 'Source Laptop · 2034-03',
    });

    currentUserId = ownerId;
    await expect(voidTransaction(orgSlug, transactionId, 'Oops')).rejects.toThrow(
      /generated by depreciation/i,
    );
    expect(await isVoided(transactionId)).toBe(false);
  });

  it.skipIf(!has0031)('refuses to void an asset disposal entry (needs 0031)', async () => {
    const transactionId = await newManualJournal();
    await admin.unsafe('update fixed_assets set disposal_transaction_id = $1 where id = $2', [
      transactionId,
      assetId,
    ]);

    expect(await sourceOf(transactionId)).toEqual({
      type: 'asset_disposal',
      id: assetId,
      label: 'Source Laptop',
    });

    currentUserId = ownerId;
    await expect(voidTransaction(orgSlug, transactionId, 'Oops')).rejects.toThrow(
      /generated by disposal/i,
    );
  });

  it('still voids a manual entry', async () => {
    const journalId = await newManualJournal();
    currentUserId = ownerId;
    await voidTransaction(orgSlug, journalId, 'Entered twice');
    expect(await isVoided(journalId)).toBe(true);

    const { id: expenseId } = await createTransaction(orgSlug, {
      kind: 'expense',
      occurredOn: DAY,
      amount: '20.00',
      currency: 'MYR',
      moneyAccountId: cashId,
      categoryId: rentCategoryId,
      clientUuid: randomUUID(),
    });
    await voidTransaction(orgSlug, expenseId, 'Entered twice');
    expect(await isVoided(expenseId)).toBe(true);
  });
});
