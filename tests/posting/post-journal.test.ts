import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import type { OrgContext } from '@/server/auth/guard';
import { LedgerError } from '@/server/domain/ledger';
import { postJournal, type PostJournalInput } from '@/server/posting/post-journal';
import {
  createTestOrgWithSeed,
  createTestUser,
  resetTestData,
  seedRate,
  type SeededOrg,
} from '@/tests/helpers/test-db';

let ownerId: string;
let org: SeededOrg;
let ctx: OrgContext;

const suffix = randomUUID().slice(0, 8);
const DAY = '2026-09-05';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-postjournal-${suffix}@example.com`, 'Owner');
  org = await createTestOrgWithSeed(ownerId, 'Post Journal Co', `post-journal-${suffix}`, 'MYR');

  ctx = {
    userId: ownerId,
    organizationId: org.id,
    orgSlug: org.slug,
    role: 'owner',
    baseCurrency: 'MYR',
    lockedUntil: null,
  };
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

function baseInput(overrides: Partial<PostJournalInput> = {}): PostJournalInput {
  return {
    event: { type: 'journal', debitAccountId: org.accountsByCode.cash, creditAccountId: org.accountsByCode.suspense, amountMinor: 1000n },
    occurredOn: DAY,
    description: 'test posting',
    currency: 'MYR',
    manualRateEntry: 'available',
    categoryId: null,
    clientUuid: randomUUID(),
    ...overrides,
  };
}

async function linesFor(transactionId: string) {
  return admin`
    select a.code, l.direction, l.amount_minor
    from journal_lines l join accounts a on a.id = l.account_id
    where l.transaction_id = ${transactionId}
    order by l.direction
  `;
}

async function transactionCount(clientUuid: string) {
  const rows = await admin`
    select id from transactions
    where organization_id = ${org.id} and client_uuid = ${clientUuid}
  `;
  return rows.length;
}

async function auditRowsFor(transactionId: string) {
  return admin`
    select id, after from audit_logs
    where entity_id = ${transactionId} and action = 'transaction.created'
  `;
}

describe('postJournal - the four posting shapes', () => {
  it('income: debits the money account and credits the revenue account', async () => {
    const input = baseInput({
      event: {
        type: 'income',
        moneyAccountId: org.accountsByCode.cash,
        revenueAccountId: org.accountsByCode.sales,
        amountMinor: 15000n,
      },
      categoryId: org.categoriesByAccountCode.sales,
    });

    const result = await withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));
    expect(result.deduplicated).toBe(false);

    expect(await linesFor(result.transactionId)).toEqual([
      { code: 'cash', direction: 'debit', amount_minor: '15000' },
      { code: 'sales', direction: 'credit', amount_minor: '15000' },
    ]);
  });

  it('expense: debits the expense account and credits the money account', async () => {
    const input = baseInput({
      event: {
        type: 'expense',
        moneyAccountId: org.accountsByCode.cash,
        expenseAccountId: org.accountsByCode.purchases,
        amountMinor: 5000n,
      },
      categoryId: org.categoriesByAccountCode.purchases,
    });

    const result = await withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));

    expect(await linesFor(result.transactionId)).toEqual([
      { code: 'purchases', direction: 'debit', amount_minor: '5000' },
      { code: 'cash', direction: 'credit', amount_minor: '5000' },
    ]);
  });

  it('transfer: debits the destination account and credits the source account', async () => {
    const input = baseInput({
      event: {
        type: 'transfer',
        fromAccountId: org.accountsByCode.cash,
        toAccountId: org.accountsByCode.bank,
        amountMinor: 2000n,
      },
      categoryId: null,
    });

    const result = await withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));

    expect(await linesFor(result.transactionId)).toEqual([
      { code: 'bank', direction: 'debit', amount_minor: '2000' },
      { code: 'cash', direction: 'credit', amount_minor: '2000' },
    ]);
  });

  it('journal: debits and credits exactly the two accounts named in the event', async () => {
    const input = baseInput({
      event: {
        type: 'journal',
        debitAccountId: org.accountsByCode.cash,
        creditAccountId: org.accountsByCode.suspense,
        amountMinor: 999n,
      },
      categoryId: null,
    });

    const result = await withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));

    expect(await linesFor(result.transactionId)).toEqual([
      { code: 'cash', direction: 'debit', amount_minor: '999' },
      { code: 'suspense', direction: 'credit', amount_minor: '999' },
    ]);
  });
});

describe('postJournal - audit trail', () => {
  it('writes exactly one audit entry per event type', async () => {
    const events: PostJournalInput['event'][] = [
      { type: 'income', moneyAccountId: org.accountsByCode.cash, revenueAccountId: org.accountsByCode.sales, amountMinor: 100n },
      { type: 'expense', moneyAccountId: org.accountsByCode.cash, expenseAccountId: org.accountsByCode.purchases, amountMinor: 100n },
      { type: 'transfer', fromAccountId: org.accountsByCode.cash, toAccountId: org.accountsByCode.bank, amountMinor: 100n },
      { type: 'journal', debitAccountId: org.accountsByCode.cash, creditAccountId: org.accountsByCode.suspense, amountMinor: 100n },
    ];

    // 借方代码、贷方代码。审计快照要能被人读懂，uuid 读不懂，而科目日后
    // 还可能改名或停用，所以代码要在事发当时就写进快照。
    const expectedCodes: Record<string, [string, string]> = {
      income: ['cash', 'sales'],
      expense: ['purchases', 'cash'],
      transfer: ['bank', 'cash'],
      journal: ['cash', 'suspense'],
    };

    for (const event of events) {
      const categoryId =
        event.type === 'income'
          ? org.categoriesByAccountCode.sales
          : event.type === 'expense'
            ? org.categoriesByAccountCode.purchases
            : null;

      const input = baseInput({ event, categoryId, sourceType: 'test-fixture', sourceId: 'abc-123' });
      const result = await withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));

      const auditRows = await auditRowsFor(result.transactionId);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].after).toMatchObject({
        kind: event.type,
        sourceType: 'test-fixture',
        sourceId: 'abc-123',
      });

      const after = auditRows[0].after as {
        lines: { accountId: string; accountCode: string; direction: string }[];
      };
      expect(after.lines.map((line) => [line.direction, line.accountCode])).toEqual([
        ['debit', expectedCodes[event.type][0]],
        ['credit', expectedCodes[event.type][1]],
      ]);
      // uuid 没被代码顶替掉，两者并存。
      expect(after.lines.every((line) => typeof line.accountId === 'string')).toBe(true);
    }
  });
});

describe('postJournal - idempotency', () => {
  it('returns the existing transaction on a repeated clientUuid and writes nothing new', async () => {
    const clientUuid = randomUUID();
    const input = baseInput({ clientUuid });

    const first = await withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));
    expect(first.deduplicated).toBe(false);

    const second = await withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));
    expect(second.deduplicated).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);

    expect(await transactionCount(clientUuid)).toBe(1);

    const lineRows = await admin`
      select id from journal_lines where transaction_id = ${first.transactionId}
    `;
    expect(lineRows).toHaveLength(2);

    const auditRows = await auditRowsFor(first.transactionId);
    expect(auditRows).toHaveLength(1);
  });
});

describe('postJournal - period lock', () => {
  it('throws on a date inside a locked period and writes nothing', async () => {
    const lockedCtx: OrgContext = { ...ctx, lockedUntil: '2026-08-31' };
    const clientUuid = randomUUID();
    const input = baseInput({ occurredOn: '2026-08-15', clientUuid });

    await expect(
      withTransaction(ownerId, (tx) => postJournal(tx, lockedCtx, input)),
    ).rejects.toThrow(/locked/i);

    expect(await transactionCount(clientUuid)).toBe(0);
  });
});

describe('postJournal - rate resolution', () => {
  it('throws when the currency is foreign and no cached or manual rate exists, and writes nothing', async () => {
    const clientUuid = randomUUID();
    const input = baseInput({
      currency: 'EUR',
      occurredOn: '2031-01-15', // far enough out that no rate has been (or will be) seeded
      clientUuid,
    });

    await expect(
      withTransaction(ownerId, (tx) => postJournal(tx, ctx, input)),
    ).rejects.toThrow(LedgerError);

    expect(await transactionCount(clientUuid)).toBe(0);
  });

  /**
   * 这两条量的是那句报错让用户去做的事，在这个入口做不做得到。
   *
   * 原来它一律以「Enter one manually.」结尾。交易表单上确实有 RateField，
   * 这句话是对的；定期规则的补记没有汇率字段——recurring_transactions 里
   * 没有这一列，界面上也没有这一栏——手工凭证同样没有。而缺汇率恰恰是定期
   * 补记最常见的失败：findRate 只回溯 7 天，cron 只同步「今天」，补记历史
   * 月份的外币规则必然查不到。于是撞得最多的那个入口，读到的是一句指向
   * 不存在的输入框的话。
   */
  const NO_RATE_DAY = '2031-01-16'; // 同样没有、也不会有汇率

  it('tells a caller with a rate field to enter one manually', async () => {
    const input = baseInput({
      currency: 'EUR',
      occurredOn: NO_RATE_DAY,
      manualRateEntry: 'available',
      clientUuid: randomUUID(),
    });

    await expect(
      withTransaction(ownerId, (tx) => postJournal(tx, ctx, input)),
    ).rejects.toThrow(/Enter one manually\./);
  });

  it('does not tell a caller without a rate field to enter one manually', async () => {
    const input = baseInput({
      currency: 'EUR',
      occurredOn: NO_RATE_DAY,
      manualRateEntry: 'unavailable',
      clientUuid: randomUUID(),
    });

    const run = () => withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));

    await expect(run()).rejects.toThrow(/Record this entry yourself under Transactions/);
    await expect(run()).rejects.not.toThrow(/Enter one manually/);
    // 两句都必须先说清楚缺的是哪一对货币、哪一天。
    await expect(run()).rejects.toThrow(/No exchange rate available for EUR to MYR on 2031-01-16/);
  });

  it('succeeds once a cached rate is available', async () => {
    await seedRate('EUR', 'MYR', 470000000n, '2031-02-10');

    const clientUuid = randomUUID();
    const input = baseInput({ currency: 'EUR', occurredOn: '2031-02-10', clientUuid });

    const result = await withTransaction(ownerId, (tx) => postJournal(tx, ctx, input));
    expect(result.deduplicated).toBe(false);
    expect(await transactionCount(clientUuid)).toBe(1);
  });

  /**
   * assertLineInvariants 的 I4，从真实数据这一头量。
   *
   * 删掉边界上那一句 assertLineInvariants，整个测试套件仍然全绿——因为 I3
   * 在当前这条路径上恒成立（所有模板都出两行同额分录），而 I4 原先只有
   * 手搓 DraftJournalLine[] 的单元测试，没有任何一条走过数据库。于是那一句
   * 看起来像是可以删的。它不是：I4 是这条路径上唯一真正拦得住东西的一条。
   *
   * 缓存里出现一个恰好 1.00000000 的外币汇率，不需要任何人犯错：
   * 0001_core_schema.sql 的约束只写了 rate > 0，upsertRates 不另加检查，
   * 汇率源写错一格、返回默认值、或某天真的报了 1，都会原样落进表里。
   * resolveRate 会把它当成一个正常的 auto 汇率返回（rate.ts），
   * 于是一笔 EUR 交易按 1:1 记成 MYR——两条腿都错同一个倍数，
   * journal_lines 那个只比合计的延迟触发器完全看不见。
   */
  it('rejects a cached foreign rate of exactly 1 and writes nothing', async () => {
    await seedRate('EUR', 'MYR', 100000000n, '2031-03-10');

    const clientUuid = randomUUID();
    const input = baseInput({ currency: 'EUR', occurredOn: '2031-03-10', clientUuid });

    await expect(
      withTransaction(ownerId, (tx) => postJournal(tx, ctx, input)),
    ).rejects.toThrow(/automatic rate of exactly 1/i);

    // 表头和分录都必须一行都没有：I4 在第 7 步 insertTransaction 之前跑，
    // 靠的不是事务回滚事后擦干净。
    expect(await transactionCount(clientUuid)).toBe(0);

    const lineRows = await admin`
      select l.id
      from journal_lines l
      join transactions t on t.id = l.transaction_id
      where t.organization_id = ${org.id} and t.client_uuid = ${clientUuid}
    `;
    expect(lineRows).toHaveLength(0);
  });
});

describe('postJournal - account ownership', () => {
  it('rejects an accountId from another organisation and writes nothing', async () => {
    const otherOwner = await createTestUser(`test-other-postjournal-${suffix}@example.com`, 'Other');
    const other = await createTestOrgWithSeed(otherOwner, 'Other Co', `post-journal-other-${suffix}`, 'MYR');

    const clientUuid = randomUUID();
    const input = baseInput({
      event: {
        type: 'journal',
        debitAccountId: org.accountsByCode.cash,
        creditAccountId: other.accountsByCode.cash, // belongs to a different organisation
        amountMinor: 500n,
      },
      clientUuid,
    });

    await expect(
      withTransaction(ownerId, (tx) => postJournal(tx, ctx, input)),
    ).rejects.toThrow(LedgerError);

    expect(await transactionCount(clientUuid)).toBe(0);

    const orphanLines = await admin`
      select id from journal_lines where organization_id = ${org.id} and account_id = ${other.accountsByCode.cash}
    `;
    expect(orphanLines).toHaveLength(0);
  });
});
