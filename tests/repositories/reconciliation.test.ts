/**
 * 银行对账的两个取数函数。
 *
 * 这两个函数此前没有任何测试，而它们各自都带着一个只在特定公司里才看得见
 * 的错：
 *
 *   - getBookBalance 求和用的是 journal_lines.amount_minor（**原币**），
 *     而界面上那个数字挂的是本位币的符号。一家马币公司的银行账户上只要有
 *     一笔美元收款，账面余额就是美元和马币相加的结果。
 *   - listUnreconciledTransactions 带出来的是 transactions.amount_minor，
 *     那是分录的借方合计，恒为正：一笔 500 的收款和一笔 500 的付款在对账
 *     界面上长得一模一样。而对账恰恰是唯一一个「钱是进是出」就是全部意义
 *     的界面。
 *   - 同一笔交易在同一个资金账户上有两条分录时（转账里单独走一行的手续费
 *     就是这样），直接 join 会让它在列表里出现两次，同一个 id 两行。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';
import { getBookBalance, listUnreconciledTransactions } from '@/server/repositories/reconciliation';

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let orgId: string;
let bankId: string;
let salesId: string;

type Leg = { accountId: string; direction: 'debit' | 'credit'; minor: bigint; baseMinor: bigint };

/**
 * 直接插一笔交易和它的分录。
 *
 * 不走 postJournal 是有意的：这里要构造的恰恰是模板不会生成的形状（同一个
 * 资金账户上两条腿、原币与本位币差着一个汇率），而被测的是读取侧。
 *
 * 所有分录必须在**同一个显式事务**里插完。journal_lines 上的
 * journal_lines_balanced 是 `deferrable initially deferred` 的约束触发器，
 * 校验发生在提交那一刻：一条一条自动提交地插，第一条腿单独提交时借贷当然
 * 不平，整条被回滚——而这次回滚在 postgres.js 这一侧不会抛错，那句 insert
 * 看上去是成功的，只是事后一行都查不到。改用 admin.begin 之后，两条腿同属
 * 一次提交，触发器看到的是配平后的完整一笔。
 */
async function insertTransaction(args: {
  occurredOn: string;
  description: string;
  currency: string;
  amountMinor: bigint;
  baseAmountMinor: bigint;
  rate: string;
  legs: Leg[];
  voided?: boolean;
}): Promise<string> {
  return admin.begin(async (tx) => {
    const [row] = await tx`
      insert into transactions
        (organization_id, kind, occurred_on, description, currency, amount_minor,
         base_amount_minor, exchange_rate, rate_source, created_by, client_uuid,
         voided_at, voided_by, void_reason)
      values (${orgId}, 'journal', ${args.occurredOn}::date, ${args.description},
         ${args.currency}, ${args.amountMinor.toString()}, ${args.baseAmountMinor.toString()},
         ${args.rate}, 'manual', ${ownerId}, ${randomUUID()},
         ${args.voided ? new Date().toISOString() : null},
         ${args.voided ? ownerId : null},
         ${args.voided ? 'test' : null})
      returning id
    `;
    const id = row.id as string;

    for (const leg of args.legs) {
      await tx`
        insert into journal_lines
          (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
        values (${id}, ${orgId}, ${leg.accountId}, ${leg.direction},
                ${leg.minor.toString()}, ${leg.baseMinor.toString()})
      `;
    }
    return id;
  }).then(async (id) => {
    await assertLinesPersisted(id as string, args.legs.length);
    return id as string;
  });
}

/**
 * 分录真的落库了才算数。
 *
 * 写这一层是因为上面那个坑：一次被静默回滚的插入，在调用侧看起来与成功
 * 完全一样，而后面每一条断言都会以「读取函数有问题」的面目失败。这里把
 * 「夹具没造出来」和「被测代码不对」分开。
 */
async function assertLinesPersisted(transactionId: string, expected: number): Promise<void> {
  const [row] = await admin`
    select count(*)::int as n from journal_lines where transaction_id = ${transactionId}
  `;
  if ((row.n as number) !== expected) {
    throw new Error(
      `fixture did not persist: transaction ${transactionId} has ${row.n} journal lines, expected ${expected}`,
    );
  }
}

/** 把一笔交易标记成「上一期已经对过账了」。 */
async function markReconciled(transactionId: string): Promise<void> {
  const [rec] = await admin`
    insert into bank_reconciliations
      (organization_id, money_account_id, statement_date, statement_balance_minor, created_by)
    values (${orgId}, ${bankId}, '2031-12-31'::date, 0, ${ownerId})
    returning id
  `;
  await admin`
    insert into reconciliation_items (reconciliation_id, transaction_id, is_cleared)
    values (${rec.id}, ${transactionId}, true)
  `;
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-recon-${suffix}@example.com`, 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Recon Co', `recon-co-${suffix}`, 'MYR');
  orgId = org.id;
  bankId = org.accountsByCode['bank'];
  salesId = org.accountsByCode['sales'];
});

afterAll(async () => {
  await admin`
    delete from reconciliation_items
    where reconciliation_id in (select id from bank_reconciliations where organization_id = ${orgId})
  `;
  await admin`delete from bank_reconciliations where organization_id = ${orgId}`;
  await resetTestData();
  await admin.end();
});

describe('listUnreconciledTransactions', () => {
  it('进账为正、出账为负——原来两者都是正的，看不出钱的方向', async () => {
    const received = await insertTransaction({
      occurredOn: '2032-01-05',
      description: 'money in',
      currency: 'MYR',
      amountMinor: 50_000n,
      baseAmountMinor: 50_000n,
      rate: '1',
      legs: [
        { accountId: bankId, direction: 'debit', minor: 50_000n, baseMinor: 50_000n },
        { accountId: salesId, direction: 'credit', minor: 50_000n, baseMinor: 50_000n },
      ],
    });
    const paid = await insertTransaction({
      occurredOn: '2032-01-06',
      description: 'money out',
      currency: 'MYR',
      amountMinor: 50_000n,
      baseAmountMinor: 50_000n,
      rate: '1',
      legs: [
        { accountId: salesId, direction: 'debit', minor: 50_000n, baseMinor: 50_000n },
        { accountId: bankId, direction: 'credit', minor: 50_000n, baseMinor: 50_000n },
      ],
    });

    const rows = await withTransaction(ownerId, (tx) =>
      listUnreconciledTransactions(tx, orgId, bankId),
    );
    const byId = new Map(rows.map((r) => [r.id, r.effectMinor]));

    expect(byId.get(received)).toBe(50_000n);
    expect(byId.get(paid)).toBe(-50_000n);
  });

  it('外币交易按本位币计——原来带出来的是原币金额', async () => {
    // USD 100.00 @ 4.50 = RM 450.00。
    const id = await insertTransaction({
      occurredOn: '2032-02-01',
      description: 'usd in',
      currency: 'USD',
      amountMinor: 10_000n,
      baseAmountMinor: 45_000n,
      rate: '4.5',
      legs: [
        { accountId: bankId, direction: 'debit', minor: 10_000n, baseMinor: 45_000n },
        { accountId: salesId, direction: 'credit', minor: 10_000n, baseMinor: 45_000n },
      ],
    });

    const rows = await withTransaction(ownerId, (tx) =>
      listUnreconciledTransactions(tx, orgId, bankId),
    );

    expect(rows.find((r) => r.id === id)!.effectMinor).toBe(45_000n);
  });

  it('同一个资金账户上有两条分录的交易只出现一次，而且是净额', async () => {
    // 收 100 进银行，同一笔里银行又扣掉 20 手续费，净进 80。
    const id = await insertTransaction({
      occurredOn: '2032-03-01',
      description: 'two legs on the same account',
      currency: 'MYR',
      amountMinor: 10_000n,
      baseAmountMinor: 10_000n,
      rate: '1',
      legs: [
        { accountId: bankId, direction: 'debit', minor: 10_000n, baseMinor: 10_000n },
        { accountId: bankId, direction: 'credit', minor: 2_000n, baseMinor: 2_000n },
        { accountId: salesId, direction: 'credit', minor: 8_000n, baseMinor: 8_000n },
      ],
    });

    const rows = await withTransaction(ownerId, (tx) =>
      listUnreconciledTransactions(tx, orgId, bankId),
    );
    const matching = rows.filter((r) => r.id === id);

    // 原来是两行：同一个 id 出现两次，React 的 key 撞号，合计算两遍。
    expect(matching).toHaveLength(1);
    expect(matching[0].effectMinor).toBe(8_000n);
  });

  it('已经对过账的交易不再出现在列表里', async () => {
    const id = await insertTransaction({
      occurredOn: '2032-04-01',
      description: 'already reconciled',
      currency: 'MYR',
      amountMinor: 30_000n,
      baseAmountMinor: 30_000n,
      rate: '1',
      legs: [
        { accountId: bankId, direction: 'debit', minor: 30_000n, baseMinor: 30_000n },
        { accountId: salesId, direction: 'credit', minor: 30_000n, baseMinor: 30_000n },
      ],
    });
    await markReconciled(id);

    const rows = await withTransaction(ownerId, (tx) =>
      listUnreconciledTransactions(tx, orgId, bankId),
    );

    expect(rows.map((r) => r.id)).not.toContain(id);
  });

  it('作废的交易两边都不算', async () => {
    const id = await insertTransaction({
      occurredOn: '2032-05-01',
      description: 'voided',
      currency: 'MYR',
      amountMinor: 70_000n,
      baseAmountMinor: 70_000n,
      rate: '1',
      voided: true,
      legs: [
        { accountId: bankId, direction: 'debit', minor: 70_000n, baseMinor: 70_000n },
        { accountId: salesId, direction: 'credit', minor: 70_000n, baseMinor: 70_000n },
      ],
    });

    const [rows, balance] = await withTransaction(ownerId, async (tx) => [
      await listUnreconciledTransactions(tx, orgId, bankId),
      await getBookBalance(tx, orgId, bankId),
    ]);

    expect(rows.map((r) => r.id)).not.toContain(id);
    // 上面几条用例的净额：50000 - 50000 + 45000 + 8000 + 30000（已对账的那笔
    // 仍然在账面上）= 83000。作废的 70000 一分都不在里面。
    expect(balance).toBe(83_000n);
  });
});

describe('getBookBalance 与列表的关系', () => {
  it('账面余额 - 所有未对账交易的净额 = 以前各期已对完的余额', async () => {
    // 这正是对账界面推算「以前各期已对完的余额」的方式，两个函数必须用同一
    // 把尺（都按 base_amount_minor、都按借贷定号），这条式子才成立。
    const [rows, balance] = await withTransaction(ownerId, async (tx) => [
      await listUnreconciledTransactions(tx, orgId, bankId),
      await getBookBalance(tx, orgId, bankId),
    ]);

    const unreconciled = rows.reduce((sum, r) => sum + r.effectMinor, 0n);

    // 唯一对过账的就是那笔 30,000。
    expect(balance - unreconciled).toBe(30_000n);
  });
});
