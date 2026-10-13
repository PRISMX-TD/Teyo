import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@/lib/supabase/storage', () => ({
  getStorageClient: () => ({
    upload: async (path: string) => ({ path }),
    createSignedUrl: async (path: string) => `https://storage.test/${path}`,
    remove: async () => {},
  }),
}));

const { createTransaction, replaceTransaction, voidTransaction } = await import(
  '@/server/actions/transactions'
);
const { uploadAttachment } = await import('@/server/actions/attachments');
const { createBill } = await import('@/server/actions/bills');

let ownerId: string;
let bookkeeperId: string;
let otherBookkeeperId: string;
let viewerId: string;
let orgId: string;
let orgSlug: string;
let cashId: string;
let bankId: string;
let rentCategoryId: string;
let salesCategoryId: string;

const suffix = randomUUID().slice(0, 8);

/** 与本仓库其它交易测试错开日期，免得撞上谁的封账设置。 */
const DAY = '2026-09-03';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-repl-${suffix}@example.com`, 'Owner');
  bookkeeperId = await createTestUser(`test-book-repl-${suffix}@example.com`, 'Book');
  otherBookkeeperId = await createTestUser(`test-book2-repl-${suffix}@example.com`, 'Book 2');
  viewerId = await createTestUser(`test-viewer-repl-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'Replace Co', `replace-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  cashId = org.accountsByCode.cash;
  bankId = org.accountsByCode.bank;
  rentCategoryId = org.categoriesByAccountCode.rent;
  salesCategoryId = org.categoriesByAccountCode.sales;

  await joinOrg(bookkeeperId, orgId, 'bookkeeper');
  await joinOrg(otherBookkeeperId, orgId, 'bookkeeper');
  await joinOrg(viewerId, orgId, 'viewer');
});

afterAll(async () => {
  await admin`update organizations set locked_until = null where id = ${orgId}`;
  await resetTestData();
  await admin.end();
});

async function newExpense(byUserId = ownerId, description = 'Recorded as an expense') {
  currentUserId = byUserId;
  const { id } = await createTransaction(orgSlug, {
    kind: 'expense',
    occurredOn: DAY,
    amount: '250.00',
    currency: 'MYR',
    moneyAccountId: cashId,
    categoryId: rentCategoryId,
    description,
    clientUuid: randomUUID(),
  });
  return id;
}

function asTransfer(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'transfer' as const,
    occurredOn: DAY,
    amount: '250.00',
    currency: 'MYR',
    moneyAccountId: bankId,
    counterAccountId: cashId,
    description: 'Actually moved cash to the bank',
    clientUuid: randomUUID(),
    voidReason: 'Re-entered as Transfer',
    ...overrides,
  };
}

async function transactionRow(id: string) {
  const [row] = await admin`
    select kind, category_id, amount_minor, description, voided_at, voided_by, void_reason
    from transactions where id = ${id}
  `;
  return row;
}

describe('replaceTransaction', () => {
  it('creates the new record with the new type and voids the original', async () => {
    const originalId = await newExpense();

    currentUserId = ownerId;
    const { id, deduplicated } = await replaceTransaction(orgSlug, originalId, asTransfer());

    expect(deduplicated).toBe(false);
    expect(id).not.toBe(originalId);

    const created = await transactionRow(id);
    expect(created.kind).toBe('transfer');
    expect(created.category_id).toBeNull();
    expect(created.amount_minor).toBe('25000');
    expect(created.voided_at).toBeNull();

    const original = await transactionRow(originalId);
    expect(original.voided_at).not.toBeNull();
    expect(original.voided_by).toBe(ownerId);
    expect(original.void_reason).toBe('Re-entered as Transfer');
  });

  it('records which record replaced the original in the void audit entry', async () => {
    const originalId = await newExpense();

    currentUserId = ownerId;
    const { id } = await replaceTransaction(orgSlug, originalId, asTransfer());

    const [log] = await admin`
      select after from audit_logs
      where entity_id = ${originalId} and action = 'transaction.voided'
    `;
    expect(log.after).toMatchObject({ replacedBy: id, attachmentsMoved: 0 });
  });

  it('moves the receipts from the original to the new record', async () => {
    const originalId = await newExpense();
    currentUserId = ownerId;
    const { id: attachmentId } = await uploadAttachment(
      orgSlug,
      originalId,
      new File([new Uint8Array(16)], 'receipt.jpg', { type: 'image/jpeg' }),
    );

    const { id } = await replaceTransaction(orgSlug, originalId, asTransfer());

    const [row] = await admin`select transaction_id from attachments where id = ${attachmentId}`;
    expect(row.transaction_id).toBe(id);
    const [log] = await admin`
      select after from audit_logs
      where entity_id = ${originalId} and action = 'transaction.voided'
    `;
    expect(log.after).toMatchObject({ attachmentsMoved: 1 });
  });

  it('can turn an expense into income', async () => {
    const originalId = await newExpense();

    currentUserId = ownerId;
    const { id } = await replaceTransaction(orgSlug, originalId, {
      kind: 'income',
      occurredOn: DAY,
      amount: '250.00',
      currency: 'MYR',
      moneyAccountId: cashId,
      categoryId: salesCategoryId,
      clientUuid: randomUUID(),
      voidReason: 'Re-entered as Money in',
    });

    const created = await transactionRow(id);
    expect(created.kind).toBe('income');
    expect(created.category_id).toBe(salesCategoryId);
  });

  it('is idempotent on the new record’s clientUuid', async () => {
    const originalId = await newExpense();
    const input = asTransfer();

    currentUserId = ownerId;
    const first = await replaceTransaction(orgSlug, originalId, input);
    // 同一份表单重放（网络抖了一下又提交一次）：不能再建一笔，也不能因为
    // 「原交易已经作废」而报错——那一次本来就成功了。
    const second = await replaceTransaction(orgSlug, originalId, input);

    expect(second).toEqual({ id: first.id, deduplicated: true });
    const [{ count }] = await admin`
      select count(*)::int as count from transactions where client_uuid = ${input.clientUuid}
    `;
    expect(count).toBe(1);
  });

  it('leaves the original untouched when the new record is invalid', async () => {
    const originalId = await newExpense();

    currentUserId = ownerId;
    // 收入却给了支出的分类：resolveCounterAccountId 会拒。新建失败，整个事务
    // 回滚——原交易不能在这时被作废掉，否则账上就少了一笔。
    await expect(
      replaceTransaction(orgSlug, originalId, {
        kind: 'income',
        occurredOn: DAY,
        amount: '250.00',
        currency: 'MYR',
        moneyAccountId: cashId,
        categoryId: rentCategoryId,
        clientUuid: randomUUID(),
        voidReason: 'Re-entered as Money in',
      }),
    ).rejects.toThrow();

    const original = await transactionRow(originalId);
    expect(original.voided_at).toBeNull();
  });

  it('refuses an original that is already voided, and creates nothing', async () => {
    const originalId = await newExpense();
    currentUserId = ownerId;
    await voidTransaction(orgSlug, originalId, 'Duplicate');

    const input = asTransfer();
    await expect(replaceTransaction(orgSlug, originalId, input)).rejects.toMatchObject({
      code: 'forbidden',
    });
    const rows = await admin`select id from transactions where client_uuid = ${input.clientUuid}`;
    expect(rows).toHaveLength(0);
  });

  it('lets only one of two simultaneous re-entries of the same record through', async () => {
    // 两个人（或同一个人开了两个标签页）同时把同一笔换类型：没有行锁时两边
    // 都可能读到「未作废」，各建一笔新的——同一笔钱入账两次。这条能不能撞上
    // 那个窗口看时机，稳定复现竞态的是下面作废那一条；这里守的是结果。
    const originalId = await newExpense();
    const first = asTransfer();
    const second = asTransfer();

    currentUserId = ownerId;
    const results = await Promise.allSettled([
      replaceTransaction(orgSlug, originalId, first),
      replaceTransaction(orgSlug, originalId, second),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'forbidden' });
    const [{ count }] = await admin`
      select count(*)::int as count from transactions
      where client_uuid in (${first.clientUuid}, ${second.clientUuid})
    `;
    expect(count).toBe(1);
  });

  it('lets only one of two simultaneous voids of the same record through', async () => {
    const originalId = await newExpense();

    currentUserId = ownerId;
    const results = await Promise.allSettled([
      voidTransaction(orgSlug, originalId, 'First'),
      voidTransaction(orgSlug, originalId, 'Second'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [{ count }] = await admin`
      select count(*)::int as count from audit_logs
      where entity_id = ${originalId} and action = 'transaction.voided'
    `;
    expect(count).toBe(1);
  });

  it('lets a bookkeeper re-enter their own record', async () => {
    const originalId = await newExpense(bookkeeperId);

    currentUserId = bookkeeperId;
    const { id } = await replaceTransaction(orgSlug, originalId, asTransfer());
    expect((await transactionRow(id)).kind).toBe('transfer');
    expect((await transactionRow(originalId)).voided_at).not.toBeNull();
  });

  it('does not let a bookkeeper re-enter someone else’s record', async () => {
    const originalId = await newExpense(bookkeeperId);

    currentUserId = otherBookkeeperId;
    const input = asTransfer();
    await expect(replaceTransaction(orgSlug, originalId, input)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await transactionRow(originalId)).voided_at).toBeNull();
    expect(
      await admin`select id from transactions where client_uuid = ${input.clientUuid}`,
    ).toHaveLength(0);
  });

  it('blocks a viewer', async () => {
    const originalId = await newExpense();

    currentUserId = viewerId;
    await expect(replaceTransaction(orgSlug, originalId, asTransfer())).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('refuses an entry generated by a document', async () => {
    const [vendor] = await admin`
      insert into contacts (organization_id, type, name)
      values (${orgId}, 'vendor', 'Replace Vendor')
      returning id
    `;
    currentUserId = ownerId;
    const { transactionId } = await createBill(orgSlug, {
      contactId: vendor.id as string,
      issueDate: DAY,
      dueDate: '2026-10-03',
      currency: 'MYR',
      items: [{ description: 'Stock', amount: '40.00' }],
    });

    await expect(
      replaceTransaction(orgSlug, transactionId as string, asTransfer()),
    ).rejects.toThrow(/bill/i);
    expect((await transactionRow(transactionId as string)).voided_at).toBeNull();
  });

  it('respects the period lock on the original’s date', async () => {
    // 原记录由记账员自己录：换成别人录的，这条用例会因为「无权改别人的记录」
    // 而通过，量不到封账这一道。
    const originalId = await newExpense(bookkeeperId);
    await admin`update organizations set locked_until = ${DAY} where id = ${orgId}`;
    try {
      currentUserId = bookkeeperId;
      // 新记录的日期在封账期之后，原记录在封账期内：作废原记录这一步要拒。
      await expect(
        replaceTransaction(orgSlug, originalId, asTransfer({ occurredOn: '2026-09-20' })),
      ).rejects.toThrow(/locked/i);
      expect((await transactionRow(originalId)).voided_at).toBeNull();
    } finally {
      await admin`update organizations set locked_until = null where id = ${orgId}`;
    }
  });

  it('needs a void reason', async () => {
    const originalId = await newExpense();

    currentUserId = ownerId;
    await expect(
      replaceTransaction(orgSlug, originalId, asTransfer({ voidReason: '   ' })),
    ).rejects.toThrow();
    expect((await transactionRow(originalId)).voided_at).toBeNull();
  });
});
