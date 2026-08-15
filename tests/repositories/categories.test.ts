import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { listRecentCategories } from '@/server/repositories/categories';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

let ownerId: string;

const suffix = randomUUID().slice(0, 8);

/**
 * 直接插一笔交易，绕过 Action 与借贷平衡。journal_lines_balanced 是挂在
 * journal_lines 表上的约束触发器（见 0001_core_schema.sql），只在这张表
 * 变更时才会触发；listRecentCategories 只读 categories 与 transactions，
 * 从不碰 journal_lines，这里配平分录纯属多余。
 */
async function insertTx(
  organizationId: string,
  args: {
    kind: 'income' | 'expense';
    occurredOn: string;
    categoryId: string;
    voided?: boolean;
  },
): Promise<string> {
  const [row] = await admin`
    insert into transactions (
      organization_id, kind, occurred_on, currency,
      amount_minor, base_amount_minor, exchange_rate,
      category_id, created_by, client_uuid, voided_at, voided_by, void_reason
    ) values (
      ${organizationId}, ${args.kind}, ${args.occurredOn}, 'MYR',
      1000, 1000, 1,
      ${args.categoryId}, ${ownerId}, ${randomUUID()},
      ${args.voided ? admin`now()` : null},
      ${args.voided ? ownerId : null},
      ${args.voided ? 'test void' : null}
    )
    returning id
  `;
  return row.id as string;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * 查询语句里的 90 天窗口用的是数据库自己的 current_date，不是测试进程的
 * 时钟。边界用例从数据库读回“今天”，再做纯字符串日期算术，避免两边时区
 * 或执行时刻不一致导致的偶发失败。
 */
async function dbToday(): Promise<Date> {
  const [{ today }] = await admin`select current_date::text as today`;
  return new Date(`${today}T00:00:00Z`);
}

function isoDaysBefore(base: Date, n: number): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-recent-cat-${suffix}@example.com`, 'Owner');
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('listRecentCategories', () => {
  it('ranks by usage count within the last 90 days, most-used first, and omits categories never used', async () => {
    const org = await createTestOrgWithSeed(
      ownerId,
      'Recent Cat Order Co',
      `recent-cat-order-${suffix}`,
      'MYR',
    );
    const rent = org.categoriesByAccountCode.rent;
    const marketing = org.categoriesByAccountCode.marketing;
    const salaries = org.categoriesByAccountCode.salaries;

    await insertTx(org.id, { kind: 'expense', occurredOn: daysAgo(10), categoryId: rent });
    await insertTx(org.id, { kind: 'expense', occurredOn: daysAgo(20), categoryId: rent });
    await insertTx(org.id, { kind: 'expense', occurredOn: daysAgo(30), categoryId: rent });
    await insertTx(org.id, { kind: 'expense', occurredOn: daysAgo(5), categoryId: marketing });
    await insertTx(org.id, { kind: 'expense', occurredOn: daysAgo(5), categoryId: marketing });
    // salaries never touched — an inner-joined category with zero uses must not appear.

    const recent = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'expense'),
    );
    const ids = recent.map((c) => c.id);

    expect(ids.indexOf(rent)).toBe(0);
    expect(ids.indexOf(marketing)).toBe(1);
    expect(ids).not.toContain(salaries);

    // Row shape sanity check — same mapping listSelectableCategories uses.
    expect(recent[0].nameEn).toBe('Rent');
    expect(recent[0].accountId).toBe(org.accountsByCode.rent);
  });

  it('excludes system-only categories even when they would otherwise rank first', async () => {
    const org = await createTestOrgWithSeed(
      ownerId,
      'Recent Cat System Co',
      `recent-cat-system-${suffix}`,
      'MYR',
    );
    // Depreciation/amortization are seeded with is_system_only = true (see
    // server/services/account-seed.ts) — the same categories
    // listSelectableCategories keeps out of the entry form's dropdown.
    const depreciation = org.categoriesByAccountCode.depreciation;
    const rent = org.categoriesByAccountCode.rent;

    for (let i = 0; i < 5; i++) {
      await insertTx(org.id, {
        kind: 'expense',
        occurredOn: daysAgo(i + 1),
        categoryId: depreciation,
      });
    }
    await insertTx(org.id, { kind: 'expense', occurredOn: daysAgo(1), categoryId: rent });

    const recent = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'expense'),
    );
    const ids = recent.map((c) => c.id);

    expect(ids).not.toContain(depreciation);
    expect(ids).toContain(rent);
  });

  it('excludes voided transactions from the usage count', async () => {
    const org = await createTestOrgWithSeed(
      ownerId,
      'Recent Cat Voided Co',
      `recent-cat-voided-${suffix}`,
      'MYR',
    );
    const rent = org.categoriesByAccountCode.rent;

    await insertTx(org.id, {
      kind: 'expense',
      occurredOn: daysAgo(2),
      categoryId: rent,
      voided: true,
    });

    const recent = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'expense'),
    );
    expect(recent.map((c) => c.id)).not.toContain(rent);
  });

  it('includes a transaction exactly 90 days old and excludes one 91 days old', async () => {
    const org = await createTestOrgWithSeed(
      ownerId,
      'Recent Cat Boundary Co',
      `recent-cat-boundary-${suffix}`,
      'MYR',
    );
    const rent = org.categoriesByAccountCode.rent;
    const marketing = org.categoriesByAccountCode.marketing;
    const today = await dbToday();

    await insertTx(org.id, {
      kind: 'expense',
      occurredOn: isoDaysBefore(today, 90),
      categoryId: rent,
    });
    await insertTx(org.id, {
      kind: 'expense',
      occurredOn: isoDaysBefore(today, 91),
      categoryId: marketing,
    });

    const recent = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'expense'),
    );
    const ids = recent.map((c) => c.id);

    expect(ids).toContain(rent);
    expect(ids).not.toContain(marketing);
  });

  it('defaults the limit to 6 and honours an explicit limit', async () => {
    const org = await createTestOrgWithSeed(
      ownerId,
      'Recent Cat Limit Co',
      `recent-cat-limit-${suffix}`,
      'MYR',
    );
    // Every non-system-only seeded expense category (see SEED_CATEGORIES),
    // used once each so all 9 qualify for ranking.
    const codes = [
      'purchases',
      'rent',
      'salaries',
      'utilities',
      'marketing',
      'transport',
      'professional-fees',
      'ai-llm-costs',
      'other-expenses',
    ];
    for (const code of codes) {
      await insertTx(org.id, {
        kind: 'expense',
        occurredOn: daysAgo(1),
        categoryId: org.categoriesByAccountCode[code],
      });
    }

    const defaultLimited = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'expense'),
    );
    expect(defaultLimited).toHaveLength(6);

    const customLimited = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'expense', 3),
    );
    expect(customLimited).toHaveLength(3);

    const unlimited = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'expense', 20),
    );
    expect(unlimited).toHaveLength(codes.length);
  });

  it('keeps the income and expense pools separate', async () => {
    const org = await createTestOrgWithSeed(
      ownerId,
      'Recent Cat Kind Co',
      `recent-cat-kind-${suffix}`,
      'MYR',
    );
    const sales = org.categoriesByAccountCode.sales;
    const rent = org.categoriesByAccountCode.rent;

    await insertTx(org.id, { kind: 'income', occurredOn: daysAgo(1), categoryId: sales });
    await insertTx(org.id, { kind: 'expense', occurredOn: daysAgo(1), categoryId: rent });

    const income = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'income'),
    );
    const expense = await withTransaction(ownerId, (tx) =>
      listRecentCategories(tx, org.id, 'expense'),
    );

    expect(income.map((c) => c.id)).toEqual([sales]);
    expect(expense.map((c) => c.id)).toEqual([rent]);
  });
});
