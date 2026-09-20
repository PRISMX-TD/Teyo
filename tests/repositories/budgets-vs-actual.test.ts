/**
 * 预算 vs 实际。
 *
 * 钉住的是 phase 2B 修掉的那条失效 LEFT JOIN：作废与期间两个条件原来挂在
 * `left join transactions` 的 ON 子句上，对驱动表（accounts → journal_lines）
 * 不起过滤作用，于是 actual_minor 变成「该科目有史以来的全部发生额，且包含
 * 已作废交易」，而 budget 是单月的。
 *
 * 本文件自建公司与科目，不与任何别的测试文件共享状态。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';
import { getBudgetVsActual, setBudget } from '@/server/repositories/budgets';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { updateBudget } = await import('@/server/actions/budgets');

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let orgId: string;
let orgSlug: string;
let accountsByCode: Record<string, string>;

/** 直接插一笔配平的本位币交易。kind 用 'transfer' 以绕开「收支必须有分类」的 CHECK。 */
async function insertBalancedTransaction(args: {
  occurredOn: string;
  amountMinor: bigint;
  debitAccountId: string;
  creditAccountId: string;
  voided?: boolean;
}): Promise<void> {
  const [txn] = await admin`
    insert into transactions
      (organization_id, kind, occurred_on, description, currency,
       amount_minor, base_amount_minor, exchange_rate, category_id,
       created_by, client_uuid)
    values (${orgId}, 'transfer', ${args.occurredOn}::date, 'budget fixture', 'MYR',
       ${args.amountMinor.toString()}, ${args.amountMinor.toString()}, 1, null,
       ${ownerId}, gen_random_uuid())
    returning id
  `;
  const txnId = txn.id as string;

  await admin`
    insert into journal_lines
      (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
    values
      (${txnId}, ${orgId}, ${args.debitAccountId}, 'debit', ${args.amountMinor.toString()}, ${args.amountMinor.toString()}),
      (${txnId}, ${orgId}, ${args.creditAccountId}, 'credit', ${args.amountMinor.toString()}, ${args.amountMinor.toString()})
  `;

  if (args.voided) {
    await admin`
      update transactions
      set voided_at = now(), voided_by = ${ownerId}, void_reason = 'budget fixture void'
      where id = ${txnId}
    `;
  }
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-bud-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;

  const org = await createTestOrgWithSeed(ownerId, 'Budget Co', `budget-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  accountsByCode = org.accountsByCode;

  // 2026-05：本月 rent 支出 1,200.00（借 rent / 贷 cash）
  await insertBalancedTransaction({
    occurredOn: '2026-05-10',
    amountMinor: 120000n,
    debitAccountId: accountsByCode.rent,
    creditAccountId: accountsByCode.cash,
  });
  // 2026-05：作废的一笔 9,999.00，绝不能计入
  await insertBalancedTransaction({
    occurredOn: '2026-05-11',
    amountMinor: 999900n,
    debitAccountId: accountsByCode.rent,
    creditAccountId: accountsByCode.cash,
    voided: true,
  });
  // 2026-04（上月）与 2026-06（下月）各一笔，绝不能被 5 月的查询看见
  await insertBalancedTransaction({
    occurredOn: '2026-04-30',
    amountMinor: 500000n,
    debitAccountId: accountsByCode.rent,
    creditAccountId: accountsByCode.cash,
  });
  await insertBalancedTransaction({
    occurredOn: '2026-06-01',
    amountMinor: 700000n,
    debitAccountId: accountsByCode.rent,
    creditAccountId: accountsByCode.cash,
  });
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('getBudgetVsActual - 失效 LEFT JOIN 回归', () => {
  it('只算本月、且排除作废交易的发生额', async () => {
    const rows = await withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 2026, 5));
    const rent = rows.find((r) => r.accountCode === 'rent');

    expect(rent, 'rent 科目必须出现在预算表里').toBeDefined();
    // 旧写法会给出 120000 + 999900(作废) + 500000(上月) + 700000(下月) = 2319900。
    expect(rent!.actualMinor).toBe(120000n);
  });

  it('相邻月份各自只看见自己那一笔', async () => {
    const april = await withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 2026, 4));
    const june = await withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 2026, 6));

    expect(april.find((r) => r.accountCode === 'rent')!.actualMinor).toBe(500000n);
    expect(june.find((r) => r.accountCode === 'rent')!.actualMinor).toBe(700000n);
  });

  it('没有任何分录的科目仍然出现，实际为 0', async () => {
    const rows = await withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 2026, 5));
    const marketing = rows.find((r) => r.accountCode === 'marketing');

    expect(marketing, '零发生额的活跃科目不能从列表里消失').toBeDefined();
    expect(marketing!.actualMinor).toBe(0n);
    expect(marketing!.budgetMinor).toBe(0n);
  });

  it('variance = 预算 − 实际', async () => {
    await withTransaction(ownerId, (tx) =>
      setBudget(tx, orgId, accountsByCode.rent, 2026, 5, 100000n),
    );

    const rows = await withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 2026, 5));
    const rent = rows.find((r) => r.accountCode === 'rent')!;

    expect(rent.budgetMinor).toBe(100000n);
    expect(rent.actualMinor).toBe(120000n);
    expect(rent.varianceMinor).toBe(-20000n);
  });

  it('归档科目只要还有预算或发生额就保留（I10 同理）', async () => {
    await admin`update accounts set is_active = false where id = ${accountsByCode.rent}`;

    const rows = await withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 2026, 5));
    const rent = rows.find((r) => r.accountCode === 'rent');

    expect(rent, '归档但本月有发生额/有预算的科目必须留在表里').toBeDefined();
    expect(rent!.actualMinor).toBe(120000n);

    // 真正零余额、零预算的归档科目照旧不显示。
    await admin`update accounts set is_active = false where id = ${accountsByCode.marketing}`;
    const after = await withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 2026, 5));
    expect(after.some((r) => r.accountCode === 'marketing')).toBe(false);

    await admin`update accounts set is_active = true where id = any(${[accountsByCode.rent, accountsByCode.marketing]})`;
  });

  it('拒绝越界的年月，而不是拼出一个非法日期让 Postgres 报错', async () => {
    await expect(
      withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 2026, 13)),
    ).rejects.toThrow(/month must be an integer between 1 and 12/);

    await expect(
      withTransaction(ownerId, (tx) => getBudgetVsActual(tx, orgId, 12, 5)),
    ).rejects.toThrow(/year must be an integer/);
  });
});

describe('updateBudget - 按本位币的小数位数解析金额', () => {
  it('零小数币种（JPY）不再被放大 100 倍', async () => {
    const jpyOrg = await createTestOrgWithSeed(
      ownerId,
      'Yen Co',
      `yen-co-${suffix}`,
      'JPY',
    );

    await updateBudget(jpyOrg.slug, {
      accountId: jpyOrg.accountsByCode.rent,
      year: 2026,
      month: 5,
      amount: '1000',
    });

    const [row] = await admin`
      select budget_minor from budgets
      where organization_id = ${jpyOrg.id} and account_id = ${jpyOrg.accountsByCode.rent}
        and year = 2026 and month = 5
    `;
    // 硬编码 exponent = 2 时这里会是 100000（￥100,000，凭空放大 100 倍）。
    expect(BigInt(row.budget_minor as string)).toBe(1000n);
  });

  it('两位小数币种（MYR）照旧按分解析', async () => {
    await updateBudget(orgSlug, {
      accountId: accountsByCode.utilities,
      year: 2026,
      month: 5,
      amount: '250.50',
    });

    const [row] = await admin`
      select budget_minor from budgets
      where organization_id = ${orgId} and account_id = ${accountsByCode.utilities}
        and year = 2026 and month = 5
    `;
    expect(BigInt(row.budget_minor as string)).toBe(25050n);
  });

  it('审计记录写得进去（entity_id 是 uuid 列，回归钉子）', async () => {
    // 原来 entityId 拼的是 `${accountId}/${year}/${month}`，而
    // audit_logs.entity_id 是 uuid 列——每一次保存预算都以
    // `invalid input syntax for type uuid` 抛错，从上线起没成功过一次。
    // 上一条用例已经证明预算写进去了（它依赖同一个事务里的 recordAudit
    // 不抛错），这里再直接断言审计行确实存在。
    const rows = await admin`
      select entity_id, after
      from audit_logs
      where organization_id = ${orgId}
        and action = 'budget.updated'
        and entity_id = ${accountsByCode.utilities}
    `;
    expect(rows.length).toBeGreaterThan(0);
    const after = rows[0].after as Record<string, unknown>;
    expect(after.year).toBe(2026);
    expect(after.month).toBe(5);
    expect(after.budgetMinor).toBe('25050');
    expect(after.baseCurrency).toBe('MYR');
  });

  it('拒绝越界的年月', async () => {
    await expect(
      updateBudget(orgSlug, {
        accountId: accountsByCode.utilities,
        year: 2026,
        month: 0,
        amount: '1.00',
      }),
    ).rejects.toThrow();
  });
});
