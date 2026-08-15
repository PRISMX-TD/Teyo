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
  getCashFlow,
  getGeneralLedger,
  getProfitLoss,
  getTrialBalance,
} from '@/server/repositories/reports';
import { checkBalanceSheet, checkCashFlow, checkTrialBalance } from '@/server/domain/report-invariants';

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
 *
 * `cashFlowCategory` 可选，省略时走原来不带该列的插入语句——迁移
 * 0013_account_cash_flow_category.sql 落地前，cash_flow_category 列在库里
 * 根本不存在，凡是把它写进 SQL 文本的调用（不论值是不是 null）都会在这个列
 * 缺失的窗口期报错。只有明确传了分类的调用才会触碰这一列，其余调用（本文件
 * 里绝大多数既有用法）SQL 文本与之前完全一致，不受影响。
 */
async function createScratchAccount(
  code: string,
  type: string,
  isMoney = false,
  cashFlowCategory?: 'operating' | 'investing' | 'financing',
): Promise<string> {
  const [account] = cashFlowCategory
    ? await admin`
        insert into accounts (organization_id, code, name_en, type, is_money_account, cash_flow_category)
        values (${orgId}, ${code}, ${code}, ${type}, ${isMoney}, ${cashFlowCategory})
        returning id
      `
    : await admin`
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

  it('keeps closingBalance and total correct when lines are truncated (regression pin)', async () => {
    // 钉住之前的严重缺陷：closingBalance 曾经是对被截断的 lineRows 做递进求和，
    // 行序是从早到晚，截断永远丢的是最新的交易——于是「期末余额」实际上是
    // 期中某一笔的余额，被当作期末余额展示。closingBalance 现在必须来自一个
    // 不带 limit/offset 的独立聚合查询，因此不管 lines 截不截断都必须是真实
    // 期末余额；total 必须是期间内的真实行数（不受 limit/offset 影响）。
    const glAssetId = await createScratchAccount('gl-trunc-asset', 'asset');
    const glCounterId = await createScratchAccount('gl-trunc-counter', 'expense');

    // 4 笔都是借记该资产科目，金额互不相同，方便算出确切的期末余额。
    const amounts = [1000n, 2000n, 3000n, 4000n];
    for (let i = 0; i < amounts.length; i++) {
      await insertBalancedTransaction({
        occurredOn: `2026-06-0${i + 1}`,
        amountMinor: amounts[i],
        debitAccountId: glAssetId,
        creditAccountId: glCounterId,
      });
    }
    const trueClosingBalance = amounts.reduce((sum, a) => sum + a, 0n); // 10000n

    const truncated = await withTransaction(userId, (tx) =>
      getGeneralLedger(tx, orgId, glAssetId, '2026-01-01', '2026-12-31', { limit: 2 }),
    );

    expect(truncated.lines.length).toBe(2);
    expect(truncated.total).toBe(4);
    // 如果 closingBalance 还是从截断后的 lines 递进求和算出来的，这里会是
    // 1000n + 2000n = 3000n（只到第 2 笔），而不是完整期间的 10000n。
    expect(truncated.closingBalance).toBe(trueClosingBalance);

    // 不截断时应给出同一个 closingBalance，交叉验证聚合查询本身没有算错。
    const full = await withTransaction(userId, (tx) =>
      getGeneralLedger(tx, orgId, glAssetId, '2026-01-01', '2026-12-31'),
    );
    expect(full.lines.length).toBe(4);
    expect(full.total).toBe(4);
    expect(full.closingBalance).toBe(trueClosingBalance);
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

  it('applies GENERAL_LEDGER_PAGE_MAX as the default limit', async () => {
    // cashId 在整个文件里都凑不够 500 行，所以 "<= GENERAL_LEDGER_PAGE_MAX"
    // 这种断言即使默认值被改错成一个小得多的数字也照样会通过。改用独立科目，
    // 插入一个明显大于「不小心传错默认值」这类缺陷会露馅的行数（10 行），
    // 断言不传 options 时一行不少地全部拿到，并且与显式传
    // { limit: GENERAL_LEDGER_PAGE_MAX } 的结果完全一致——直接证明默认值
    // 确实被当成 limit 传下去了，而不是巧合地没有更多数据可截断。
    const glAssetId = await createScratchAccount('gl-default-asset', 'asset');
    const glCounterId = await createScratchAccount('gl-default-counter', 'expense');

    const rowCount = 10;
    for (let i = 0; i < rowCount; i++) {
      await insertBalancedTransaction({
        occurredOn: `2026-07-${String(i + 1).padStart(2, '0')}`,
        amountMinor: 100n,
        debitAccountId: glAssetId,
        creditAccountId: glCounterId,
      });
    }

    const defaulted = await withTransaction(userId, (tx) =>
      getGeneralLedger(tx, orgId, glAssetId, '2026-01-01', '2026-12-31'),
    );
    const explicitMax = await withTransaction(userId, (tx) =>
      getGeneralLedger(tx, orgId, glAssetId, '2026-01-01', '2026-12-31', {
        limit: GENERAL_LEDGER_PAGE_MAX,
      }),
    );

    expect(defaulted.total).toBe(rowCount);
    expect(defaulted.lines.length).toBe(rowCount);
    expect(defaulted.lines.length).toBe(explicitMax.lines.length);
    expect(defaulted.closingBalance).toBe(explicitMax.closingBalance);
  });
});

describe('getCashFlow - signs and tie-out (B4 / I8)', () => {
  it('shows a loan drawdown as positive financing cash flow', async () => {
    const [loans] = await admin`
      insert into accounts (organization_id, code, name_en, type, cash_flow_category)
      values (${orgId}, 'loans', 'Loans', 'liability', 'financing') returning id
    `;

    // 借入 200000：借现金、贷借款
    await insertBalancedTransaction({
      occurredOn: '2026-04-01',
      amountMinor: 20000000n,
      debitAccountId: cashId,
      creditAccountId: loans.id as string,
    });

    const cf = await withTransaction(userId, (tx) =>
      getCashFlow(tx, orgId, '2026-04-01', '2026-04-30'),
    );

    const loanRow = cf.financing.rows.find((r) => r.label === 'loans')!;
    expect(loanRow.amountMinor).toBe(20000000n);
  });

  it('ties: opening + net change = closing', async () => {
    // 不用共享的 cash/sales/old-gear 跑全年窗口：文件里更早的用例（I10 归档
    // 科目、getGeneralLedger 的三组 scratch 科目）留下了好几个未分类的资产
    // 科目——它们的对方科目落在收入/费用上，会被 netIncome 无条件计入，
    // 资产这一侧却不属于任何分类桶，本质上让"期初+净变动=期末"这条不变量
    // 在这份共享夹具上不可能成立（与本次要修的四个缺陷无关，是更早任务留下
    // 的夹具设计问题，另见 task-11-report.md「Known risk」一节）。
    // 这里改用 cf-tie-* 专属科目 + 9 月这个其它用例都没碰过的窗口，
    // 诚实地验证生产公式本身，而不是断言一份结构上就凑不平的共享夹具。
    const tieCashId = await createScratchAccount('cf-tie-cash', 'asset', true);
    const tieRevenueId = await createScratchAccount('cf-tie-revenue', 'revenue');
    // 分类的对方科目：category='investing'，验证 Step 6 新增的
    // netFlowByCategory 路径（不是靠字面量 code 匹配）。
    const tieVanId = await createScratchAccount('cf-tie-van', 'asset', false, 'investing');

    // 现金销售：借现金、贷收入。
    await insertBalancedTransaction({
      occurredOn: '2026-09-05',
      amountMinor: 12345n,
      debitAccountId: tieCashId,
      creditAccountId: tieRevenueId,
    });
    // 用现金买一辆车：借资产（investing）、贷现金。
    await insertBalancedTransaction({
      occurredOn: '2026-09-10',
      amountMinor: 67890n,
      debitAccountId: tieVanId,
      creditAccountId: tieCashId,
    });

    const cf = await withTransaction(userId, (tx) =>
      getCashFlow(tx, orgId, '2026-09-01', '2026-09-30'),
    );

    const result = checkCashFlow({
      openingCash: cf.openingCash,
      netChange: cf.netChange,
      closingCash: cf.closingCash,
    });
    expect(result.differenceMinor).toBe(0n);
  });

  it('does not double-count a transaction dated exactly on the from-date', async () => {
    // 4/1 的借款既然计入了本期流量，就不能同时计入期初现金。
    // 只断言 tie-out：具体数值依赖前面用例插入的夹具顺序，硬编码会脆。
    const cf = await withTransaction(userId, (tx) =>
      getCashFlow(tx, orgId, '2026-04-01', '2026-04-30'),
    );
    expect(checkCashFlow(cf).differenceMinor).toBe(0n);
  });

  it('includes a to-date transaction in both netIncome and its working-capital offset (B4 boundary)', async () => {
    // 回归 defect #4：netFlow 曾用 < to（不含边界），而 getProfitLoss 早已是 <= to。
    // 用一笔恰好落在 to 当天、赊销确认收入的分录验证两者现在同口径：
    // 借 accounts-receivable、贷收入，都不触碰任何资金账户。
    // 如果 netFlow 仍是 < to，这笔分录会被 getProfitLoss 计入 netIncome，
    // 却不会被 netFlow('accounts-receivable') 计入 arChange 抵消，
    // operatingTotal 就会虚增 5000，导致本应为零的 tie-out 出现非零差额。
    // 用独立科目 + 单日区间，不依赖文件里其余用例累积的夹具，断言干净。
    const arId = await createScratchAccount('accounts-receivable', 'asset');
    const revId = await createScratchAccount('b4-boundary-revenue', 'revenue');

    await insertBalancedTransaction({
      occurredOn: '2026-08-01',
      amountMinor: 5000n,
      debitAccountId: arId,
      creditAccountId: revId,
    });

    const cf = await withTransaction(userId, (tx) =>
      getCashFlow(tx, orgId, '2026-08-01', '2026-08-01'),
    );

    const netIncomeRow = cf.operating.rows.find((r) => r.label === 'netIncome')!;
    const arRow = cf.operating.rows.find((r) => r.label === 'arChange')!;
    expect(netIncomeRow.amountMinor).toBe(5000n);
    expect(arRow.amountMinor).toBe(-5000n);
    // 两者抵消：这笔赊销对现金没有实际影响，单日区间内没有任何资金账户被触碰，
    // 所以期初必须等于期末，净变动必须为零。
    expect(cf.netChange).toBe(0n);
    expect(cf.openingCash).toBe(cf.closingCash);
    expect(checkCashFlow(cf).differenceMinor).toBe(0n);
  });

  it('an unclassified account breaks the tie-out (documents a known production gap)', async () => {
    // 这条用例把「ties」用例上面那条注释里说的缺口钉成代码，而不是只写在
    // report 里：insertAccount（server/repositories/accounts.ts）插入新科目
    // 时从不写 cash_flow_category，界面上也没有任何地方收集这个值，所以
    // 用户自建的科目在生产环境里天生就是 NULL——一旦它被记账，且对方科目落在
    // 损益表上，getCashFlow 就会不平。这里不改 accounts.ts/actions/accounts.ts
    // （收口这个缺口是后续任务，不是本任务范围），只是照着生产环境会发生的
    // 样子把它复现出来：一个未分类科目 + 一笔命中损益表的分录。
    //
    // 用独立科目 + 10 月这个其它用例都没碰过的窗口，窗口内不涉及任何资金
    // 科目变动，所以 openingCash 必然等于 closingCash，netChange 里多出来的
    // 15000 就是 checkCashFlow 报出的全部差额——这一断言一旦哪天缺口被堵上
    // （比如 insertAccount 开始要求或默认写入 cash_flow_category），就会
    // 变红，提醒这里需要重新审视。
    const gapAssetId = await createScratchAccount('cf-gap-unclassified-asset', 'asset');
    const gapRevenueId = await createScratchAccount('cf-gap-revenue', 'revenue');

    await insertBalancedTransaction({
      occurredOn: '2026-10-15',
      amountMinor: 15000n,
      debitAccountId: gapAssetId,
      creditAccountId: gapRevenueId,
    });

    const cf = await withTransaction(userId, (tx) =>
      getCashFlow(tx, orgId, '2026-10-01', '2026-10-31'),
    );

    expect(cf.openingCash).toBe(cf.closingCash);
    expect(cf.netChange).toBe(15000n);
    expect(checkCashFlow(cf).differenceMinor).toBe(15000n);
  });
});
