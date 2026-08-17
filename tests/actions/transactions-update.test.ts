import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
  seedRate,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createTransaction, updateTransaction, voidTransaction } = await import(
  '@/server/actions/transactions'
);

let ownerId: string;
let bookkeeperId: string;
let adminId: string;
let viewerId: string;
let orgId: string;
let orgSlug: string;
let cashId: string;
let bankId: string;
let rentCategoryId: string;
let utilitiesCategoryId: string;

// 第二家公司，owner 与第一家相同。用于证明公司维度收窄是应用层在挡，
// 而不是 RLS——同一用户同属两家公司时策略对两边都放行。
let otherOrgId: string;
let otherCashId: string;
let otherRentCategoryId: string;

// slug 全局唯一，固定值会让上一轮的残留数据卡死后续所有测试。
const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-upd-${suffix}@example.com`, 'Owner');
  bookkeeperId = await createTestUser(`test-book-upd-${suffix}@example.com`, 'Book');
  adminId = await createTestUser(`test-admin-upd-${suffix}@example.com`, 'Admin');
  viewerId = await createTestUser(`test-viewer-upd-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'Update Co', `update-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  cashId = org.accountsByCode.cash;
  bankId = org.accountsByCode.bank;
  rentCategoryId = org.categoriesByAccountCode.rent;
  utilitiesCategoryId = org.categoriesByAccountCode.utilities;

  await joinOrg(bookkeeperId, orgId, 'bookkeeper');
  await joinOrg(adminId, orgId, 'admin');
  await joinOrg(viewerId, orgId, 'viewer');

  const other = await createTestOrgWithSeed(ownerId, 'Other Co', `other-upd-${suffix}`, 'MYR');
  otherOrgId = other.id;
  otherCashId = other.accountsByCode.cash;
  otherRentCategoryId = other.categoriesByAccountCode.rent;
});

afterAll(async () => {
  await admin`update organizations set locked_until = null where id = ${orgId}`;
  await resetTestData();
  await admin.end();
});

async function newExpense(byUserId: string, overrides: Record<string, unknown> = {}) {
  currentUserId = byUserId;
  const { id } = await createTransaction(orgSlug, {
    kind: 'expense',
    occurredOn: '2026-08-10',
    amount: '300.00',
    currency: 'MYR',
    moneyAccountId: cashId,
    categoryId: rentCategoryId,
    description: 'Original note',
    clientUuid: randomUUID(),
    ...overrides,
  });
  return id;
}

function editInput(overrides: Record<string, unknown> = {}) {
  return {
    occurredOn: '2026-08-11',
    amount: '450.00',
    currency: 'MYR',
    moneyAccountId: bankId,
    categoryId: utilitiesCategoryId,
    description: 'Updated note',
    ...overrides,
  };
}

describe('updateTransaction', () => {
  it('rebuilds the journal lines to match the new amount and category', async () => {
    const id = await newExpense(ownerId);

    currentUserId = ownerId;
    await updateTransaction(orgSlug, id, editInput());

    const [tx] = await admin`
      select occurred_on, amount_minor, base_amount_minor, description
      from transactions where id = ${id}
    `;
    expect(tx.amount_minor).toBe('45000');
    expect(tx.base_amount_minor).toBe('45000');
    expect(tx.description).toBe('Updated note');

    const lines = await admin`
      select a.code, l.direction, l.amount_minor
      from journal_lines l join accounts a on a.id = l.account_id
      where l.transaction_id = ${id} order by l.direction
    `;

    // 旧分录被替换而不是叠加：重建的前提是先删干净。
    expect(lines).toHaveLength(2);
    expect(lines).toEqual([
      { code: 'utilities', direction: 'debit', amount_minor: '45000' },
      { code: 'bank', direction: 'credit', amount_minor: '45000' },
    ]);
  });

  it('records the before and after snapshot in the audit log', async () => {
    const id = await newExpense(ownerId);

    currentUserId = ownerId;
    await updateTransaction(
      orgSlug,
      id,
      editInput({ occurredOn: '2026-08-10', amount: '999.00', moneyAccountId: cashId }),
    );

    const [entry] = await admin`
      select before, after from audit_logs
      where entity_id = ${id} and action = 'transaction.updated'
      order by created_at desc limit 1
    `;
    // bigint 转字符串存入：jsonb 不能承载 bigint，且字符串仍可被 ->> 查询。
    expect(entry.before).toMatchObject({ amountMinor: '30000', description: 'Original note' });
    expect(entry.after).toMatchObject({ amountMinor: '99900', description: 'Updated note' });
  });

  /**
   * 改科目而金额不变，是编辑里最常见的一种：分错类了，挪一下。
   *
   * before 原来只有表头字段（日期、摘要、币种、金额、汇率来源、分类），
   * 一个字都没有科目。于是这一种编辑在审计日志里 before 与 after 的每个
   * 字段都一模一样——真正被改掉的那样东西，恰恰是没被记下来的那样。
   * 「这笔钱原来记在哪个科目上」事后再也查不回来，而这正是有人翻审计日志
   * 时要问的问题。
   */
  it('keeps the old accounts in the audit before when an edit moves a record between accounts', async () => {
    const id = await newExpense(ownerId);

    currentUserId = ownerId;
    // 只换科目：金额、日期、摘要一律照旧，所以表头字段 before 与 after 相同。
    await updateTransaction(orgSlug, id, {
      occurredOn: '2026-08-10',
      amount: '300.00',
      currency: 'MYR',
      moneyAccountId: bankId,
      categoryId: utilitiesCategoryId,
      description: 'Original note',
    });

    const [entry] = await admin`
      select before, after from audit_logs
      where entity_id = ${id} and action = 'transaction.updated'
      order by created_at desc limit 1
    `;

    const codesOf = (side: unknown) =>
      (side as { lines?: { direction: string; accountCode: string }[] }).lines?.map((line) => [
        line.direction,
        line.accountCode,
      ]);

    // 原来是「借 房租 / 贷 现金」，改成了「借 水电 / 贷 银行」。
    expect(codesOf(entry.before)).toEqual([
      ['debit', 'rent'],
      ['credit', 'cash'],
    ]);
    expect(codesOf(entry.after)).toEqual([
      ['debit', 'utilities'],
      ['credit', 'bank'],
    ]);

    // 表头那几个字段确实没变——也就是说，少了 lines 这一条就什么都看不出来。
    expect(entry.before).toMatchObject({ amountMinor: '30000', description: 'Original note' });
    expect(entry.after).toMatchObject({ amountMinor: '30000', description: 'Original note' });

    // before 与 after 形状一致，翻日志的人可以逐行对着看。
    const beforeLines = (entry.before as { lines: Record<string, unknown>[] }).lines;
    const afterLines = (entry.after as { lines: Record<string, unknown>[] }).lines;
    expect(Object.keys(beforeLines[0]).sort()).toEqual(Object.keys(afterLines[0]).sort());
    expect(beforeLines.map((l) => l.amountMinor)).toEqual(['30000', '30000']);
  });

  it('lets a bookkeeper edit their own record', async () => {
    const id = await newExpense(bookkeeperId);

    currentUserId = bookkeeperId;
    await updateTransaction(orgSlug, id, editInput({ amount: '310.00' }));

    const [tx] = await admin`select amount_minor from transactions where id = ${id}`;
    expect(tx.amount_minor).toBe('31000');
  });

  it('blocks a bookkeeper from editing someone else record', async () => {
    const id = await newExpense(ownerId);

    currentUserId = bookkeeperId;
    await expect(updateTransaction(orgSlug, id, editInput())).rejects.toThrow(/cannot edit/i);

    const [tx] = await admin`select amount_minor from transactions where id = ${id}`;
    expect(tx.amount_minor).toBe('30000');
  });

  it('lets an admin edit anyone record', async () => {
    const id = await newExpense(bookkeeperId);

    currentUserId = adminId;
    await updateTransaction(orgSlug, id, editInput({ amount: '330.00' }));

    const [tx] = await admin`select amount_minor from transactions where id = ${id}`;
    expect(tx.amount_minor).toBe('33000');
  });

  it('blocks a viewer from editing', async () => {
    const id = await newExpense(ownerId);

    currentUserId = viewerId;
    await expect(updateTransaction(orgSlug, id, editInput())).rejects.toThrow(/cannot/i);
  });

  it('refuses to edit a record inside a locked period', async () => {
    const id = await newExpense(ownerId, { occurredOn: '2026-07-15' });
    await admin`update organizations set locked_until = '2026-07-31' where id = ${orgId}`;

    currentUserId = ownerId;
    await expect(
      updateTransaction(orgSlug, id, editInput({ occurredOn: '2026-07-15', amount: '340.00' })),
    ).rejects.toThrow(/locked/i);

    await admin`update organizations set locked_until = null where id = ${orgId}`;
  });

  it('refuses to move a record out of a locked period', async () => {
    // 这条才真正量到「原日期也要校验」。上一条的新日期同样落在锁定区间内，
    // 只查新日期也照样拒绝，所以它对原日期这道防线是无感的。
    const id = await newExpense(ownerId, { occurredOn: '2026-07-15' });
    await admin`update organizations set locked_until = '2026-07-31' where id = ${orgId}`;

    currentUserId = ownerId;
    await expect(
      updateTransaction(orgSlug, id, editInput({ occurredOn: '2026-08-20' })),
    ).rejects.toThrow(/locked/i);

    await admin`update organizations set locked_until = null where id = ${orgId}`;

    const [tx] = await admin`select amount_minor from transactions where id = ${id}`;
    expect(tx.amount_minor).toBe('30000');
  });

  it('refuses to move a record into a locked period', async () => {
    const id = await newExpense(ownerId, { occurredOn: '2026-08-15' });
    await admin`update organizations set locked_until = '2026-07-31' where id = ${orgId}`;

    currentUserId = ownerId;
    await expect(
      updateTransaction(orgSlug, id, editInput({ occurredOn: '2026-07-20' })),
    ).rejects.toThrow(/locked/i);

    await admin`update organizations set locked_until = null where id = ${orgId}`;
  });

  it('refuses to edit an already voided record', async () => {
    const id = await newExpense(ownerId);
    currentUserId = ownerId;
    await voidTransaction(orgSlug, id, 'Duplicate entry');

    await expect(updateTransaction(orgSlug, id, editInput())).rejects.toThrow(/voided/i);
  });

  it('rejects a money account from another company the same user also owns', async () => {
    const id = await newExpense(ownerId);

    currentUserId = ownerId;
    await expect(
      updateTransaction(orgSlug, id, editInput({ moneyAccountId: otherCashId })),
    ).rejects.toThrow(/does not exist in this company/i);
  });

  it('rejects a category from another company the same user also owns', async () => {
    const id = await newExpense(ownerId);

    currentUserId = ownerId;
    await expect(
      updateTransaction(orgSlug, id, editInput({ categoryId: otherRentCategoryId })),
    ).rejects.toThrow(/does not exist in this company/i);
  });

  it('refuses to edit a record that belongs to another company the user owns', async () => {
    currentUserId = ownerId;
    const [foreign] = await admin`
      insert into transactions (
        organization_id, kind, occurred_on, description, currency,
        amount_minor, base_amount_minor, exchange_rate, rate_source,
        category_id, created_by, client_uuid
      ) values (
        ${otherOrgId}, 'expense', '2026-08-10', 'Foreign', 'MYR',
        10000, 10000, 1, 'auto', ${otherRentCategoryId}, ${ownerId}, ${randomUUID()}
      )
      returning id
    `;
    await admin`
      insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
      values
        (${foreign.id}, ${otherOrgId}, (select account_id from categories where id = ${otherRentCategoryId}), 'debit', 10000, 10000),
        (${foreign.id}, ${otherOrgId}, ${otherCashId}, 'credit', 10000, 10000)
    `;

    await expect(
      updateTransaction(orgSlug, foreign.id as string, editInput()),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects an amount of zero or below', async () => {
    const id = await newExpense(ownerId);
    currentUserId = ownerId;
    await expect(updateTransaction(orgSlug, id, editInput({ amount: '0.00' }))).rejects.toThrow();
    await expect(updateTransaction(orgSlug, id, editInput({ amount: '-5.00' }))).rejects.toThrow();
  });

  it('leaves the record untouched when the rebuild fails', async () => {
    const id = await newExpense(ownerId);

    currentUserId = ownerId;
    await expect(
      updateTransaction(orgSlug, id, editInput({ moneyAccountId: otherCashId })),
    ).rejects.toThrow();

    // 分录删除与重建在同一事务内，失败必须整体回滚，不能留下无分录的交易。
    const lines = await admin`select id from journal_lines where transaction_id = ${id}`;
    expect(lines).toHaveLength(2);
    const [tx] = await admin`select amount_minor from transactions where id = ${id}`;
    expect(tx.amount_minor).toBe('30000');
  });
});

// USD/MYR，2026-09 下半月：与 transactions-create.test.ts 的 SGD/MYR
// 2026-09-01、exchange-rate-sync.test.ts 整个 2026-08 月都不重叠，
// 并行跑的测试文件不会互相污染这张全局共享表。
const RATE_DAY = '2026-09-20';
const OTHER_DAY = '2026-09-22';

async function newForeignExpense(scaledRate: bigint, occurredOn = RATE_DAY) {
  await seedRate('USD', 'MYR', scaledRate, occurredOn);
  currentUserId = ownerId;
  const { id } = await createTransaction(orgSlug, {
    kind: 'expense',
    occurredOn,
    amount: '100.00',
    currency: 'USD',
    moneyAccountId: cashId,
    categoryId: rentCategoryId,
    description: 'Foreign original',
    clientUuid: randomUUID(),
  });
  return id;
}

describe('updateTransaction - foreign currency rate on save', () => {
  // Task 3 follow-up: RateField shows the record's stored rate without
  // refetching, but if the server re-resolved on every save regardless,
  // the two would still diverge the moment the cache changes underneath --
  // which happens routinely, not just if someone edits history. The daily
  // cron only upserts "today"'s row (app/api/cron/exchange-rates/route.ts),
  // so a transaction recorded before the cron runs gets an auto rate from
  // findRate's lookback to the prior business day; once the cron fills in
  // the exact date later that same day, a plain save must not silently
  // adopt it.
  it('keeps the originally-resolved rate on a description-only edit, even after the cached rate for that date changes', async () => {
    const id = await newForeignExpense(4_80000000n); // 4.80

    const [before] = await admin`
      select exchange_rate, base_amount_minor, rate_source from transactions where id = ${id}
    `;
    expect(Number(before.exchange_rate)).toBeCloseTo(4.8, 6);
    expect(before.base_amount_minor).toBe('48000');
    expect(before.rate_source).toBe('auto');

    // 模拟 cron 在同一天晚些时候把这一天的精确汇率补上，覆盖掉刚才查到的值。
    await seedRate('USD', 'MYR', 4_95000000n, RATE_DAY);

    currentUserId = ownerId;
    await updateTransaction(orgSlug, id, {
      occurredOn: RATE_DAY,
      amount: '100.00',
      currency: 'USD',
      moneyAccountId: cashId,
      categoryId: rentCategoryId,
      description: 'Typo fixed',
    });

    const [after] = await admin`
      select exchange_rate, base_amount_minor, rate_source, description
      from transactions where id = ${id}
    `;
    expect(Number(after.exchange_rate)).toBeCloseTo(4.8, 6);
    expect(after.base_amount_minor).toBe('48000');
    expect(after.rate_source).toBe('auto');
    expect(after.description).toBe('Typo fixed');
  });

  it('still re-resolves the rate when the date actually changes', async () => {
    const id = await newForeignExpense(4_80000000n);
    await seedRate('USD', 'MYR', 5_00000000n, OTHER_DAY);

    currentUserId = ownerId;
    await updateTransaction(orgSlug, id, {
      occurredOn: OTHER_DAY,
      amount: '100.00',
      currency: 'USD',
      moneyAccountId: cashId,
      categoryId: rentCategoryId,
      description: 'Moved to the day the invoice actually cleared',
    });

    const [after] = await admin`
      select exchange_rate, base_amount_minor from transactions where id = ${id}
    `;
    expect(Number(after.exchange_rate)).toBeCloseTo(5.0, 6);
    expect(after.base_amount_minor).toBe('50000');
  });

  it('still re-resolves the rate when the currency actually changes', async () => {
    const id = await newForeignExpense(4_80000000n);
    await seedRate('SGD', 'MYR', 3_10000000n, RATE_DAY);

    currentUserId = ownerId;
    await updateTransaction(orgSlug, id, {
      occurredOn: RATE_DAY,
      amount: '100.00',
      currency: 'SGD',
      moneyAccountId: cashId,
      categoryId: rentCategoryId,
      description: 'Actually paid in SGD',
    });

    const [after] = await admin`
      select currency, exchange_rate, base_amount_minor from transactions where id = ${id}
    `;
    expect(after.currency).toBe('SGD');
    expect(Number(after.exchange_rate)).toBeCloseTo(3.1, 6);
    expect(after.base_amount_minor).toBe('31000');
  });

  it('still honours an explicit manual rate override on an otherwise-unchanged edit', async () => {
    const id = await newForeignExpense(4_80000000n);

    currentUserId = ownerId;
    await updateTransaction(orgSlug, id, {
      occurredOn: RATE_DAY,
      amount: '100.00',
      currency: 'USD',
      moneyAccountId: cashId,
      categoryId: rentCategoryId,
      description: 'Bank slip actually says 4.90',
      exchangeRate: '4.90',
    });

    const [after] = await admin`
      select exchange_rate, base_amount_minor, rate_source from transactions where id = ${id}
    `;
    expect(Number(after.exchange_rate)).toBeCloseTo(4.9, 6);
    expect(after.base_amount_minor).toBe('49000');
    expect(after.rate_source).toBe('manual');
  });
});

describe('voidTransaction', () => {
  it('soft deletes with reason and actor, keeping the journal lines', async () => {
    const id = await newExpense(ownerId);

    currentUserId = ownerId;
    await voidTransaction(orgSlug, id, 'Entered twice');

    const [tx] = await admin`
      select voided_at, voided_by, void_reason from transactions where id = ${id}
    `;
    expect(tx.voided_at).not.toBeNull();
    expect(tx.voided_by).toBe(ownerId);
    expect(tx.void_reason).toBe('Entered twice');

    // 分录保留，作废后仍要可追溯。
    const lines = await admin`select id from journal_lines where transaction_id = ${id}`;
    expect(lines).toHaveLength(2);
  });

  it('requires a reason', async () => {
    const id = await newExpense(ownerId);
    currentUserId = ownerId;
    await expect(voidTransaction(orgSlug, id, '   ')).rejects.toThrow();

    const [tx] = await admin`select voided_at from transactions where id = ${id}`;
    expect(tx.voided_at).toBeNull();
  });

  it('refuses to void twice', async () => {
    const id = await newExpense(ownerId);
    currentUserId = ownerId;
    await voidTransaction(orgSlug, id, 'First');
    await expect(voidTransaction(orgSlug, id, 'Second')).rejects.toThrow(/already voided/i);

    const [tx] = await admin`select void_reason from transactions where id = ${id}`;
    expect(tx.void_reason).toBe('First');
  });

  it('blocks a viewer from voiding', async () => {
    const id = await newExpense(ownerId);
    currentUserId = viewerId;
    await expect(voidTransaction(orgSlug, id, 'Nope')).rejects.toThrow(/cannot/i);
  });

  it('blocks a bookkeeper from voiding someone else record', async () => {
    const id = await newExpense(ownerId);
    currentUserId = bookkeeperId;
    await expect(voidTransaction(orgSlug, id, 'Not mine')).rejects.toThrow(/cannot void/i);
  });

  it('refuses to void a record inside a locked period', async () => {
    const id = await newExpense(ownerId, { occurredOn: '2026-07-15' });
    await admin`update organizations set locked_until = '2026-07-31' where id = ${orgId}`;

    currentUserId = ownerId;
    await expect(voidTransaction(orgSlug, id, 'Locked')).rejects.toThrow(/locked/i);

    await admin`update organizations set locked_until = null where id = ${orgId}`;
  });

  it('writes an audit entry', async () => {
    const id = await newExpense(ownerId);
    currentUserId = ownerId;
    await voidTransaction(orgSlug, id, 'Audited void');

    const rows = await admin`
      select after from audit_logs where entity_id = ${id} and action = 'transaction.voided'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toMatchObject({ voidReason: 'Audited void' });
  });
});
