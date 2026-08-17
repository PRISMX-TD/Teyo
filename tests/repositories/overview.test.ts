import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '@/server/db/transaction';
import {
  getAccountBalances,
  getExpenseByCategory,
  getMonthTotals,
} from '@/server/repositories/overview';
import { admin } from '@/tests/helpers/db';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createTransaction, voidTransaction } = await import('@/server/actions/transactions');

let ownerId: string;
let orgId: string;
let orgSlug: string;
let cashId: string;
let bankId: string;

// 第二家公司，owner 与第一家相同。跨公司断言必须这样搭：换成别人的公司，
// RLS 会自己挡掉，聚合里少了收窄也测不出来。
let otherOrgId: string;

const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-ov-${suffix}@example.com`, 'Owner');

  const org = await createTestOrgWithSeed(
    ownerId,
    'Overview Co',
    `overview-co-${suffix}`,
    'MYR',
  );
  orgId = org.id;
  orgSlug = org.slug;
  cashId = org.accountsByCode.cash;
  bankId = org.accountsByCode.bank;
  currentUserId = ownerId;

  const add = (args: {
    kind: 'income' | 'expense' | 'transfer';
    amount: string;
    occurredOn: string;
    moneyAccountId: string;
    categoryId?: string;
    counterAccountId?: string;
  }) =>
    createTransaction(orgSlug, {
      occurredOn: args.occurredOn,
      currency: 'MYR',
      description: 'seed',
      clientUuid: randomUUID(),
      kind: args.kind,
      amount: args.amount,
      moneyAccountId: args.moneyAccountId,
      categoryId: args.categoryId,
      counterAccountId: args.counterAccountId,
    });

  // 上月：不应计入本月统计
  await add({
    kind: 'income',
    amount: '1000.00',
    occurredOn: '2026-07-20',
    moneyAccountId: bankId,
    categoryId: org.categoriesByAccountCode.sales,
  });

  // 本月收入 5000 + 500
  await add({
    kind: 'income',
    amount: '5000.00',
    occurredOn: '2026-08-02',
    moneyAccountId: bankId,
    categoryId: org.categoriesByAccountCode.sales,
  });
  await add({
    kind: 'income',
    amount: '500.00',
    occurredOn: '2026-08-05',
    moneyAccountId: cashId,
    categoryId: org.categoriesByAccountCode['other-income'],
  });

  // 本月支出 1200 租金 + 300 水电 + 200 交通
  await add({
    kind: 'expense',
    amount: '1200.00',
    occurredOn: '2026-08-03',
    moneyAccountId: bankId,
    categoryId: org.categoriesByAccountCode.rent,
  });
  await add({
    kind: 'expense',
    amount: '300.00',
    occurredOn: '2026-08-06',
    moneyAccountId: cashId,
    categoryId: org.categoriesByAccountCode.utilities,
  });
  await add({
    kind: 'expense',
    amount: '200.00',
    occurredOn: '2026-08-07',
    moneyAccountId: cashId,
    categoryId: org.categoriesByAccountCode.transport,
  });

  // 转账不影响收支，只改账户余额
  await add({
    kind: 'transfer',
    amount: '400.00',
    occurredOn: '2026-08-08',
    moneyAccountId: cashId,
    counterAccountId: bankId,
  });

  // 作废的支出，不应计入任何统计
  const voided = await add({
    kind: 'expense',
    amount: '9999.00',
    occurredOn: '2026-08-09',
    moneyAccountId: cashId,
    categoryId: org.categoriesByAccountCode.marketing,
  });
  await voidTransaction(orgSlug, voided.id, 'Entered by mistake');

  // 另一家公司也放一笔本月支出与一笔收入，用于验证聚合按公司收窄。
  const other = await createTestOrgWithSeed(ownerId, 'Other Ov', `other-ov-${suffix}`, 'MYR');
  otherOrgId = other.id;
  await createTransaction(other.slug, {
    occurredOn: '2026-08-04',
    currency: 'MYR',
    description: 'foreign',
    clientUuid: randomUUID(),
    kind: 'expense',
    amount: '7777.00',
    moneyAccountId: other.accountsByCode.cash,
    categoryId: other.categoriesByAccountCode.rent,
  });
  await createTransaction(other.slug, {
    occurredOn: '2026-08-04',
    currency: 'MYR',
    description: 'foreign',
    clientUuid: randomUUID(),
    kind: 'income',
    amount: '8888.00',
    moneyAccountId: other.accountsByCode.bank,
    categoryId: other.categoriesByAccountCode.sales,
  });
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('getMonthTotals', () => {
  it('sums income, expense and net for the month in base currency', async () => {
    const totals = await withTransaction(ownerId, (tx) => getMonthTotals(tx, orgId, '2026-08'));

    expect(totals.incomeMinor).toBe(550000n);
    expect(totals.expenseMinor).toBe(170000n);
    expect(totals.netMinor).toBe(380000n);
  });

  it('excludes other months', async () => {
    const july = await withTransaction(ownerId, (tx) => getMonthTotals(tx, orgId, '2026-07'));
    expect(july.incomeMinor).toBe(100000n);
    expect(july.expenseMinor).toBe(0n);
  });

  it('excludes transfers from income and expense', async () => {
    // 8 月有一笔 400 转账，若被计入 income 或 expense 上面的数字就不会成立
    const totals = await withTransaction(ownerId, (tx) => getMonthTotals(tx, orgId, '2026-08'));
    expect(totals.incomeMinor + totals.expenseMinor).toBe(720000n);
  });

  it('excludes voided records', async () => {
    const totals = await withTransaction(ownerId, (tx) => getMonthTotals(tx, orgId, '2026-08'));
    // 被作废的 9999 若计入，支出会是 1169900
    expect(totals.expenseMinor).toBe(170000n);
  });

  it('returns zeroes for a month with no activity', async () => {
    const totals = await withTransaction(ownerId, (tx) => getMonthTotals(tx, orgId, '2026-01'));
    expect(totals).toEqual({ incomeMinor: 0n, expenseMinor: 0n, netMinor: 0n });
  });

  it('counts only the requested company', async () => {
    const mine = await withTransaction(ownerId, (tx) => getMonthTotals(tx, orgId, '2026-08'));
    const theirs = await withTransaction(ownerId, (tx) =>
      getMonthTotals(tx, otherOrgId, '2026-08'),
    );

    expect(mine.expenseMinor).toBe(170000n);
    expect(theirs.expenseMinor).toBe(777700n);
    expect(theirs.incomeMinor).toBe(888800n);
  });

  it('rejects a malformed month', async () => {
    await expect(
      withTransaction(ownerId, (tx) => getMonthTotals(tx, orgId, '2026-8')),
    ).rejects.toThrow(/YYYY-MM/);
  });
});

describe('getAccountBalances', () => {
  it('computes each money account balance from the journal lines', async () => {
    const balances = await withTransaction(ownerId, (tx) =>
      getAccountBalances(tx, orgId, '2026-08-31'),
    );

    const cash = balances.find((b) => b.accountId === cashId);
    const bank = balances.find((b) => b.accountId === bankId);

    // 转账的 moneyAccountId 是「转入方」，会被记借方
    // （见 server/domain/posting-templates.ts 的 accountPair）。
    // 种子里那笔转账 moneyAccountId 是现金、counterAccountId 是银行，
    // 所以是银行转出 400 到现金，不是反过来。
    // 现金：+500 收入 -300 水电 -200 交通 +400 转入 = +400
    expect(cash?.balanceMinor).toBe(40000n);
    // 银行：+1000（7月）+5000 -1200 -400 转出 = 4400
    expect(bank?.balanceMinor).toBe(440000n);
  });

  it('only includes money accounts', async () => {
    const balances = await withTransaction(ownerId, (tx) =>
      getAccountBalances(tx, orgId, '2026-08-31'),
    );
    const codes = await admin`
      select code from accounts
      where organization_id = ${orgId} and id = any(${balances.map((b) => b.accountId)}::uuid[])
    `;
    expect(codes.length).toBe(balances.length);
    for (const row of codes) {
      expect(['cash', 'bank']).toContain(row.code);
    }
  });

  it('respects the as-of date', async () => {
    const balances = await withTransaction(ownerId, (tx) =>
      getAccountBalances(tx, orgId, '2026-07-31'),
    );
    const bank = balances.find((b) => b.accountId === bankId);
    expect(bank?.balanceMinor).toBe(100000n);
  });

  it('lists an untouched money account at zero rather than dropping it', async () => {
    // 新公司的资金账户还没有任何分录。左连接一旦写成内连接，这个账户会整行消失，
    // 用户会以为账户不存在，而不是余额为零。
    const fresh = await createTestOrgWithSeed(
      ownerId,
      'Fresh Ov',
      `fresh-ov-${suffix}`,
      'MYR',
    );
    const balances = await withTransaction(ownerId, (tx) =>
      getAccountBalances(tx, fresh.id, '2026-08-31'),
    );

    expect(balances.length).toBeGreaterThan(0);
    for (const b of balances) {
      expect(b.balanceMinor).toBe(0n);
    }
  });

  it('reports only the requested company', async () => {
    const balances = await withTransaction(ownerId, (tx) =>
      getAccountBalances(tx, otherOrgId, '2026-08-31'),
    );
    const ids = balances.map((b) => b.accountId);
    expect(ids).not.toContain(cashId);
    expect(ids).not.toContain(bankId);
  });
});

describe('getExpenseByCategory', () => {
  it('groups expenses by category, largest first', async () => {
    const shares = await withTransaction(ownerId, (tx) =>
      getExpenseByCategory(tx, orgId, '2026-08'),
    );

    expect(shares.map((s) => [s.nameEn, s.totalMinor])).toEqual([
      ['Rent', 120000n],
      ['Utilities', 30000n],
      ['Transport', 20000n],
    ]);
  });

  it('excludes voided expenses and transfers', async () => {
    const shares = await withTransaction(ownerId, (tx) =>
      getExpenseByCategory(tx, orgId, '2026-08'),
    );
    expect(shares.some((s) => s.nameEn === 'Marketing')).toBe(false);
    expect(shares.reduce((sum, s) => sum + s.totalMinor, 0n)).toBe(170000n);
  });

  it('groups only the requested company', async () => {
    const shares = await withTransaction(ownerId, (tx) =>
      getExpenseByCategory(tx, otherOrgId, '2026-08'),
    );
    expect(shares.map((s) => [s.nameEn, s.totalMinor])).toEqual([['Rent', 777700n]]);
  });
});
