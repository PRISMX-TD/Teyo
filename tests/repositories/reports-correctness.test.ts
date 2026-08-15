/**
 * 共享状态约定（本文件会被 Task 7/8/9/11/14 陆续追加用例，务必读完再加）：
 *
 * 全文件只有一个 `beforeAll`，建一个公司、一个用户，以及三个共享科目
 * `cashId`/`salesId`/`oldGearId`。这三个科目的余额会随着下面每个 describe
 * 块的执行按文件顺序累加——vitest 在同一文件内按声明顺序跑，`it` 之间不隔离
 * 数据库状态。举例：`I9 voided transactions` 那个用例先给 cash 记了一笔
 * 100000n 的借方（另一笔配平但作废，不计入），`as-of cutoff` 用例断言
 * `cash.debitMinor === 100000n`——这个数字之所以对，只是因为它是在前一个
 * 用例已经往 cash 上记了 100000n 之后，才追加了一笔在 as-of 日期之后、
 * 会被过滤掉的交易。任何断言 cash/sales 绝对值的用例都隐式依赖着它上面
 * 所有用例已经跑过。
 *
 * 之后追加用例时：
 * - 如果新用例需要断言某个科目的绝对借/贷合计，不要复用 cashId/salesId/
 *   oldGearId——用下面的 `createScratchAccount` 现开一个全新科目，这样断言
 *   只依赖你自己插入的交易，不用去重新算文件里前面所有用例叠加下来的总数。
 * - 如果不需要断言绝对值（比如只看 `checkTrialBalance(rows).balanced`
 *   这种全局是否配平的性质，不看某个科目具体多少），复用共享科目是安全的。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createTestUser, deleteTestUser, deleteTestOrganizations } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import {
  GENERAL_LEDGER_PAGE_MAX,
  getBalanceSheet,
  getGeneralLedger,
  getProfitLoss,
  getTrialBalance,
} from '@/server/repositories/reports';
import { checkBalanceSheet, checkTrialBalance } from '@/server/domain/report-invariants';

let userId: string;
let orgId: string;
let cashId: string;
let salesId: string;
let oldGearId: string;

/**
 * 直接插一笔配平的交易，绕过 action 层，专注测报表查询。
 *
 * kind 用 'transfer'，不是因为测的是转账——而是当前
 * transactions_category_matches_kind 这条 CHECK 约束只允许 'transfer' 在
 * category_id 为空的情况下插入（'journal' 理论上也该允许，但 0007 加枚举值
 * 时漏改了这条约束，实际会被拒绝，见 supabase/migrations/0014_allow_journal_kind_without_category.sql
 * 的说明和 task-6-report.md）。下面测的四个 getTrialBalance 场景都只按
 * voided_at / occurred_on 过滤、按 journal_lines 聚合，不看 kind，所以用
 * 'transfer' 换 category_id 为空对测试语义没有影响，只是绕开这条约束。
 */
async function insertBalancedTransaction(args: {
  occurredOn: string;
  amountMinor: bigint;
  debitAccountId: string;
  creditAccountId: string;
  voided?: boolean;
}): Promise<string> {
  const [txn] = await admin`
    insert into transactions
      (organization_id, kind, occurred_on, description, currency,
       amount_minor, base_amount_minor, exchange_rate, category_id,
       created_by, client_uuid)
    values (${orgId}, 'transfer', ${args.occurredOn}::date, 'fixture', 'MYR',
       ${args.amountMinor.toString()}, ${args.amountMinor.toString()}, 1, null,
       ${userId}, gen_random_uuid())
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
      set voided_at = now(), voided_by = ${userId}, void_reason = 'fixture void'
      where id = ${txnId}
    `;
  }

  return txnId;
}

/**
 * 为一个测试块创建独立科目，避免与共享的 cash/sales/old-gear 累计余额纠缠。
 * `code` 必须在本公司内唯一（accounts 表按 organization_id + code 建了唯一约束）。
 */
async function createScratchAccount(code: string, type: string, isMoney = false): Promise<string> {
  const [account] = await admin`
    insert into accounts (organization_id, code, name_en, type, is_money_account)
    values (${orgId}, ${code}, ${code}, ${type}, ${isMoney})
    returning id
  `;
  return account.id as string;
}

beforeAll(async () => {
  const user = await createTestUser('Reports Correctness');
  userId = user.id;

  const [org] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Reports Co', ${'rep-' + Date.now()}, 'MYR', ${userId})
    returning id
  `;
  orgId = org.id as string;

  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${userId}, ${orgId}, 'owner', 'active')
  `;

  const [cash] = await admin`
    insert into accounts (organization_id, code, name_en, type, is_money_account)
    values (${orgId}, 'cash', 'Cash', 'asset', true) returning id
  `;
  const [sales] = await admin`
    insert into accounts (organization_id, code, name_en, type)
    values (${orgId}, 'sales', 'Sales', 'revenue') returning id
  `;
  const [oldGear] = await admin`
    insert into accounts (organization_id, code, name_en, type)
    values (${orgId}, 'old-gear', 'Old Gear', 'asset') returning id
  `;
  cashId = cash.id as string;
  salesId = sales.id as string;
  oldGearId = oldGear.id as string;
});

afterAll(async () => {
  await deleteTestOrganizations([orgId]);
  await deleteTestUser(userId);
  await admin.end();
});

describe('getTrialBalance - I9 voided transactions', () => {
  it('excludes a voided transaction', async () => {
    await insertBalancedTransaction({
      occurredOn: '2026-03-01',
      amountMinor: 100000n,
      debitAccountId: cashId,
      creditAccountId: salesId,
    });
    await insertBalancedTransaction({
      occurredOn: '2026-03-02',
      amountMinor: 55555n,
      debitAccountId: cashId,
      creditAccountId: salesId,
      voided: true,
    });

    const rows = await withTransaction(userId, (tx) =>
      getTrialBalance(tx, orgId, '2026-12-31'),
    );

    const cash = rows.find((r) => r.code === 'cash')!;
    expect(cash.debitMinor).toBe(100000n);
    expect(checkTrialBalance(rows).balanced).toBe(true);
  });
});

describe('getTrialBalance - as-of cutoff', () => {
  it('excludes transactions dated after the as-of date', async () => {
    await insertBalancedTransaction({
      occurredOn: '2026-11-01',
      amountMinor: 70000n,
      debitAccountId: cashId,
      creditAccountId: salesId,
    });

    const rows = await withTransaction(userId, (tx) =>
      getTrialBalance(tx, orgId, '2026-06-30'),
    );

    const cash = rows.find((r) => r.code === 'cash')!;
    expect(cash.debitMinor).toBe(100000n);
  });
});

describe('getTrialBalance - I10 archived accounts', () => {
  it('keeps an archived account that still carries a balance, and stays balanced', async () => {
    await insertBalancedTransaction({
      occurredOn: '2026-03-05',
      amountMinor: 30000n,
      debitAccountId: oldGearId,
      creditAccountId: salesId,
    });

    await admin`update accounts set is_active = false where id = ${oldGearId}`;

    const rows = await withTransaction(userId, (tx) =>
      getTrialBalance(tx, orgId, '2026-12-31'),
    );

    const archived = rows.find((r) => r.code === 'old-gear');
    expect(archived, 'archived account with a balance must still appear').toBeDefined();
    expect(archived!.isActive).toBe(false);
    expect(archived!.debitMinor).toBe(30000n);
    expect(checkTrialBalance(rows).balanced).toBe(true);
  });

  it('keeps zero-balance active accounts in the report', async () => {
    const spareId = await createScratchAccount('spare', 'expense');
    expect(spareId).toBeDefined();

    const rows = await withTransaction(userId, (tx) =>
      getTrialBalance(tx, orgId, '2026-12-31'),
    );

    const zero = rows.find((r) => r.code === 'spare');
    expect(zero, 'a zero-balance active account must still appear').toBeDefined();
    expect(zero!.debitMinor).toBe(0n);
    expect(zero!.creditMinor).toBe(0n);
  });
});

describe('getBalanceSheet - I9 / I10', () => {
  it('excludes voided transactions and keeps archived accounts with a balance', async () => {
    const bs = await withTransaction(userId, (tx) =>
      getBalanceSheet(tx, orgId, '2026-12-31', 0n),
    );

    const cash = bs.assetRows.find((r) => r.code === 'cash')!;
    // 100000 (3/1) + 70000 (11/1) = 170000，作废的 55555 不计入
    expect(cash.totalMinor).toBe(170000n);

    const archived = bs.assetRows.find((r) => r.code === 'old-gear');
    expect(archived, 'archived account with a balance must still appear').toBeDefined();
    expect(archived!.isActive).toBe(false);
  });

  it('respects the as-of cutoff', async () => {
    const bs = await withTransaction(userId, (tx) =>
      getBalanceSheet(tx, orgId, '2026-06-30', 0n),
    );
    const cash = bs.assetRows.find((r) => r.code === 'cash')!;
    expect(cash.totalMinor).toBe(100000n);
  });
});

describe('getProfitLoss - inclusive upper bound (B2)', () => {
  it('includes a transaction dated exactly on the to-date', async () => {
    const pl = await withTransaction(userId, (tx) =>
      getProfitLoss(tx, orgId, '2026-01-01', '2026-03-01'),
    );
    // 3/1 记了 100000 的销售收入，闭区间下必须计入
    expect(pl.revenueTotal).toBe(100000n);
  });

  it('agrees with the balance sheet on the same date', async () => {
    const to = '2026-03-01';
    const pl = await withTransaction(userId, (tx) =>
      getProfitLoss(tx, orgId, '2026-01-01', to),
    );
    const bs = await withTransaction(userId, (tx) =>
      getBalanceSheet(tx, orgId, to, pl.netIncome),
    );
    const cash = bs.assetRows.find((r) => r.code === 'cash')!;
    // 同一天的销售，现金与收入必须同时出现
    expect(cash.totalMinor).toBe(100000n);
    expect(pl.revenueTotal).toBe(100000n);
  });
});

describe('getBalanceSheet - synthetic current-year earnings (B3 / I5)', () => {
  it('returns current-year earnings separately from equity', async () => {
    const to = '2026-12-31';
    const pl = await withTransaction(userId, (tx) =>
      getProfitLoss(tx, orgId, '2026-01-01', to),
    );
    const bs = await withTransaction(userId, (tx) =>
      getBalanceSheet(tx, orgId, to, pl.netIncome),
    );

    expect(bs.currentYearEarnings).toBe(pl.netIncome);
    expect(bs.equityRows.some((r) => r.code === 'retained-earnings')).toBe(false);
  });

  it('balances: assets = liabilities + equity + current-year earnings', async () => {
    const to = '2026-12-31';
    const pl = await withTransaction(userId, (tx) =>
      getProfitLoss(tx, orgId, '2026-01-01', to),
    );
    const bs = await withTransaction(userId, (tx) =>
      getBalanceSheet(tx, orgId, to, pl.netIncome),
    );

    const result = checkBalanceSheet({
      assetTotal: bs.assetTotal,
      liabilityTotal: bs.liabilityTotal,
      equityTotal: bs.equityTotal,
      currentYearEarnings: bs.currentYearEarnings,
    });
    expect(result.differenceMinor).toBe(0n);
    expect(result.balanced).toBe(true);
  });
});

describe('getGeneralLedger - bounded reads', () => {
  it('caps the number of rows returned', async () => {
    // 用独立科目而非 cashId：要造出比 limit 更多的行数才能真正验证截断生效，
    // 复用共享科目会与前面用例对 cash/sales 绝对值的断言纠缠。
    const glAssetId = await createScratchAccount('gl-scratch-asset', 'asset');
    const glCounterId = await createScratchAccount('gl-scratch-counter', 'expense');

    for (let i = 0; i < 3; i++) {
      await insertBalancedTransaction({
        occurredOn: `2026-05-0${i + 1}`,
        amountMinor: 1000n,
        debitAccountId: glAssetId,
        creditAccountId: glCounterId,
      });
    }

    const result = await withTransaction(userId, (tx) =>
      getGeneralLedger(tx, orgId, glAssetId, '2026-01-01', '2026-12-31', { limit: 2 }),
    );
    // 3 行分录存在，但 limit 是 2——如果没截断，这里会是 3。
    expect(result.lines.length).toBe(2);
  });

  it('rejects a limit above the page maximum', async () => {
    await expect(
      withTransaction(userId, (tx) =>
        getGeneralLedger(tx, orgId, cashId, '2026-01-01', '2026-12-31', {
          limit: GENERAL_LEDGER_PAGE_MAX + 1,
        }),
      ),
    ).rejects.toThrow();
  });

  it('defaults to the page maximum when no limit is given', async () => {
    const result = await withTransaction(userId, (tx) =>
      getGeneralLedger(tx, orgId, cashId, '2026-01-01', '2026-12-31'),
    );
    expect(result.lines.length).toBeLessThanOrEqual(GENERAL_LEDGER_PAGE_MAX);
  });
});
