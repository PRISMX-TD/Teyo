import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createTestUser, deleteTestUser, deleteTestOrganizations } from '@/tests/helpers/db';
import { createTestOrgWithSeed, type SeededOrg } from '@/tests/helpers/test-db';
import { withTransaction, type Tx } from '@/server/db/transaction';
import type { OrgContext } from '@/server/auth/guard';
import {
  buildClosingPlan,
  closeFiscalYear,
  fiscalYearFor,
  previousFiscalYear,
  undoFiscalYearClose,
  YearEndCloseError,
  type ClosingPoster,
} from '@/server/services/year-end-close';
import { todayLocalISO } from '@/lib/date';
import {
  findFiscalYearClosing,
  getFiscalYearClosingById,
} from '@/server/repositories/fiscal-year-closings';

/* =========================================================================
   1. 财年边界（纯函数，不碰数据库）
   ========================================================================= */

describe('fiscalYearFor / previousFiscalYear', () => {
  it('财年 1 月起时就是日历年', () => {
    expect(fiscalYearFor('2026-05-10', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(previousFiscalYear('2026-05-10', 1)).toEqual({
      start: '2025-01-01',
      end: '2025-12-31',
    });
  });

  it('财年跨自然年时，起始月之前的日子属于上一个开始的财年', () => {
    // 7 月起：3 月 15 日属于去年 7 月开始的那一个。
    expect(fiscalYearFor('2026-03-15', 7)).toEqual({ start: '2025-07-01', end: '2026-06-30' });
    // 同一个财年的最后一天。
    expect(fiscalYearFor('2026-06-30', 7)).toEqual({ start: '2025-07-01', end: '2026-06-30' });
    // 下一个财年的第一天——差一天就换一个财年，这是最容易写错的边界。
    expect(fiscalYearFor('2026-07-01', 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
  });

  it('12 月起：财年几乎整个落在下一个自然年里', () => {
    expect(fiscalYearFor('2026-01-05', 12)).toEqual({ start: '2025-12-01', end: '2026-11-30' });
    expect(fiscalYearFor('2025-12-01', 12)).toEqual({ start: '2025-12-01', end: '2026-11-30' });
    expect(fiscalYearFor('2025-11-30', 12)).toEqual({ start: '2024-12-01', end: '2025-11-30' });
  });

  it('3 月起：结束日落在 2 月，闰年要多一天', () => {
    // 2024 是闰年（能被 4 整除、不是整百）。
    expect(fiscalYearFor('2023-06-01', 3)).toEqual({ start: '2023-03-01', end: '2024-02-29' });
    // 2023 不是。
    expect(fiscalYearFor('2022-06-01', 3)).toEqual({ start: '2022-03-01', end: '2023-02-28' });
    // 2000 能被 400 整除，是闰年——这一条是 `% 4 === 0` 那种简化写法唯一
    // 会答错的方向（它会答对 2000 但答错 1900，见下一条）。
    expect(fiscalYearFor('1999-06-01', 3)).toEqual({ start: '1999-03-01', end: '2000-02-29' });
    // 1900 是整百且不能被 400 整除，不是闰年。
    expect(fiscalYearFor('1899-06-01', 3)).toEqual({ start: '1899-03-01', end: '1900-02-28' });
  });

  it('每个起始月的结束日都是那个月的最后一天', () => {
    const expectedEndDay: Record<number, string> = {
      1: '12-31', 2: '01-31', 3: '02-28', 4: '03-31', 5: '04-30', 6: '05-31',
      7: '06-30', 8: '07-31', 9: '08-31', 10: '09-30', 11: '10-31', 12: '11-30',
    };
    for (let month = 1; month <= 12; month += 1) {
      // 2025-2026 都不是闰年，2 月固定 28 天。
      const year = fiscalYearFor('2026-12-15', month);
      expect(year.end.slice(5)).toBe(expectedEndDay[month]);
      expect(year.start.slice(5)).toBe(`${String(month).padStart(2, '0')}-01`);
    }
  });

  it('上一个财年恰好接在本财年前面，中间不空一天也不重一天', () => {
    for (let month = 1; month <= 12; month += 1) {
      const current = fiscalYearFor('2026-09-09', month);
      const previous = previousFiscalYear('2026-09-09', month);
      // 上一年的结束日 + 1 天 = 本年的开始日。用 Date 做这一步加法是安全的：
      // 这是断言侧，不是被测代码，而且两端都用 UTC 构造，不经本地时区。
      const dayAfter = new Date(`${previous.end}T00:00:00Z`);
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      expect(dayAfter.toISOString().slice(0, 10)).toBe(current.start);
    }
  });

  it('起始月与日期都必须合法，不合法就抛错而不是猜', () => {
    expect(() => fiscalYearFor('2026-01-01', 0)).toThrow(YearEndCloseError);
    expect(() => fiscalYearFor('2026-01-01', 13)).toThrow(YearEndCloseError);
    expect(() => fiscalYearFor('2026-01-01', 1.5)).toThrow(YearEndCloseError);
    expect(() => fiscalYearFor('2026-1-1', 1)).toThrow(YearEndCloseError);
    expect(() => fiscalYearFor('not-a-date', 1)).toThrow(YearEndCloseError);
    // 日历上不存在的日子。不挡的话它会被当成 2 月的某一天算出一个财年，
    // 而那个财年看起来完全正常。
    expect(() => fiscalYearFor('2026-02-30', 1)).toThrow(YearEndCloseError);
    expect(() => fiscalYearFor('2026-13-01', 1)).toThrow(YearEndCloseError);
  });
});

/* =========================================================================
   2. 年结分录（要数据库）
   ========================================================================= */

let userId: string;
let org: SeededOrg;
let ctx: OrgContext;

/** 2025 财年（日历年）的一笔收入与一笔费用，直接插，不经 action 层。 */
async function seedYear(): Promise<void> {
  await insertBalanced('2025-03-01', 500_000n, org.accountsByCode.cash, org.accountsByCode.sales);
  await insertBalanced('2025-06-01', 200_000n, org.accountsByCode.rent, org.accountsByCode.cash);
  // 财年之外的一笔：绝不能进年结。
  await insertBalanced('2026-02-01', 900_000n, org.accountsByCode.cash, org.accountsByCode.sales);
}

async function insertBalanced(
  occurredOn: string,
  amountMinor: bigint,
  debitAccountId: string,
  creditAccountId: string,
): Promise<string> {
  const [txn] = await admin`
    insert into transactions
      (organization_id, kind, occurred_on, description, currency,
       amount_minor, base_amount_minor, exchange_rate, category_id, created_by, client_uuid)
    values (${org.id}, 'transfer', ${occurredOn}::date, 'fixture', 'MYR',
       ${amountMinor.toString()}, ${amountMinor.toString()}, 1, null, ${userId}, gen_random_uuid())
    returning id
  `;
  const id = txn.id as string;
  await admin`
    insert into journal_lines
      (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
    values
      (${id}, ${org.id}, ${debitAccountId}, 'debit', ${amountMinor.toString()}, ${amountMinor.toString()}),
      (${id}, ${org.id}, ${creditAccountId}, 'credit', ${amountMinor.toString()}, ${amountMinor.toString()})
  `;
  return id;
}

/**
 * 测试用的年结分录写入口。
 *
 * 生产代码里这一步该走 postJournal，但记账边界现在还表达不了 kind =
 * 'closing' 的 n 行分录（见 server/actions/year_end.ts 上 postClosingEntry
 * 的注释）。这里用被测事务自己的 tx 直接插——**不是** admin 连接：走 tx
 * 意味着这几行同样要过 RLS（owner 身份）与 journal_lines 的延迟配平触发器，
 * 于是「年结分录真的能落库、真的配平」这件事仍然被测到，只有「谁来写」
 * 这一步是替身。
 */
const testPoster: ClosingPoster = async (tx, context, entry) => {
  const debitTotal = entry.lines
    .filter((line) => line.direction === 'debit')
    .reduce((sum, line) => sum + line.amountMinor, 0n);

  const [txn] = await tx`
    insert into transactions
      (organization_id, kind, occurred_on, description, currency,
       amount_minor, base_amount_minor, exchange_rate, rate_source,
       category_id, created_by, client_uuid)
    values (${context.organizationId}, 'closing', ${entry.occurredOn}::date,
       ${entry.description}, ${context.baseCurrency},
       ${debitTotal.toString()}, ${debitTotal.toString()}, 1, 'manual',
       null, ${context.userId}, ${entry.clientUuid})
    returning id
  `;
  const transactionId = txn.id as string;

  for (const line of entry.lines) {
    await tx`
      insert into journal_lines
        (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
      values (${transactionId}, ${context.organizationId}, ${line.accountId},
              ${line.direction}, ${line.amountMinor.toString()}, ${line.amountMinor.toString()})
    `;
  }

  return { transactionId };
};

beforeAll(async () => {
  const user = await createTestUser('Year End Owner');
  userId = user.id;
  org = await createTestOrgWithSeed(userId, 'Year End Co', `ye-${Date.now()}`);
  ctx = {
    userId,
    organizationId: org.id,
    orgSlug: org.slug,
    role: 'owner',
    baseCurrency: 'MYR',
    lockedUntil: null,
    timezone: 'Asia/Kuala_Lumpur',
  };
  await seedYear();
});

afterAll(async () => {
  await deleteTestOrganizations([org.id]);
  await deleteTestUser(userId);
});

const FY2025 = { start: '2025-01-01', end: '2025-12-31' };

describe('buildClosingPlan', () => {
  it('借每个收入科目、贷每个费用科目，差额进留存收益', async () => {
    const plan = await withTransaction(userId, (tx) => buildClosingPlan(tx, ctx, FY2025));

    expect(plan.netIncomeMinor).toBe(300_000n);

    const byCode = new Map(plan.lines.map((line) => [line.code, line]));
    expect(byCode.get('sales')).toMatchObject({ direction: 'debit', amountMinor: 500_000n });
    expect(byCode.get('rent')).toMatchObject({ direction: 'credit', amountMinor: 200_000n });
    expect(byCode.get('retained-earnings')).toMatchObject({
      direction: 'credit',
      amountMinor: 300_000n,
      accountType: 'equity',
    });
    // 财年之外的那 900,000 一分都不能进来。
    expect(plan.lines.reduce((sum, l) => sum + l.amountMinor, 0n)).toBe(
      500_000n + 200_000n + 300_000n,
    );
  });

  it('借贷两侧合计相等', async () => {
    const plan = await withTransaction(userId, (tx) => buildClosingPlan(tx, ctx, FY2025));
    const debit = plan.lines.filter((l) => l.direction === 'debit')
      .reduce((s, l) => s + l.amountMinor, 0n);
    const credit = plan.lines.filter((l) => l.direction === 'credit')
      .reduce((s, l) => s + l.amountMinor, 0n);
    expect(debit).toBe(credit);
  });

  it('没有任何损益发生的财年结不了，而且说得出原因', async () => {
    await expect(
      withTransaction(userId, (tx) =>
        buildClosingPlan(tx, ctx, { start: '2019-01-01', end: '2019-12-31' }),
      ),
    ).rejects.toThrow(YearEndCloseError);
  });
});

describe('closeFiscalYear', () => {
  it('还没过完的财年不能结', async () => {
    await expect(
      withTransaction(userId, (tx) =>
        closeFiscalYear(
          tx,
          ctx,
          {
            period: FY2025,
            today: '2025-06-30', // 财年还没到期
            description: 'too early',
            clientUuid: randomUUID(),
          },
          testPoster,
        ),
      ),
    ).rejects.toThrow(YearEndCloseError);
  });

  it('封账覆盖了财年最后一天时不能结，并且提示的是封账', async () => {
    await expect(
      withTransaction(userId, (tx) =>
        closeFiscalYear(
          tx,
          { ...ctx, lockedUntil: '2026-01-31' },
          {
            period: FY2025,
            today: '2026-09-01',
            description: 'locked',
            clientUuid: randomUUID(),
          },
          testPoster,
        ),
      ),
    ).rejects.toThrow(/lock/i);
  });

  it('结转、登记、审计三件事在同一个事务里完成', async () => {
    const result = await withTransaction(userId, (tx) =>
      closeFiscalYear(
        tx,
        ctx,
        {
          period: FY2025,
          today: '2026-09-01',
          description: 'Year-end closing 2025',
          clientUuid: randomUUID(),
        },
        testPoster,
      ),
    );

    expect(result.netIncomeMinor).toBe(300_000n);

    const [txnRow] = await admin`
      select kind, occurred_on, category_id, currency, exchange_rate, voided_at
      from transactions where id = ${result.transactionId}
    `;
    expect(txnRow.kind).toBe('closing');
    // 年结记在财年最后一天。
    //
    // 不能写 String(occurred_on).slice(0, 10)：postgres.js 把 date 列解析成
    // JS 的 Date 对象，String() 给出的是 "Wed Dec 31 2025 00:00:00 GMT+0800"，
    // 切前十位得到 "Wed Dec 31"。这个坑 server/repositories/reports.ts 里
    // 修过一次（那里的 toIsoDate），这是它第二次出现。
    //
    // 也不能用 toISOString()：那会先转 UTC，而这个 Date 是本地零点——
    // 在 UTC+8 下会退回 12 月 30 日。必须取本地日期分量，这正是
    // lib/date.ts 的 todayLocalISO 做的事。
    expect(todayLocalISO(txnRow.occurred_on as Date)).toBe('2025-12-31');
    // kind = 'closing' 不带分类（0024 的 transactions_category_matches_kind）。
    expect(txnRow.category_id).toBeNull();
    expect(txnRow.currency).toBe('MYR');
    expect(Number(txnRow.exchange_rate)).toBe(1);

    const closing = await withTransaction(userId, (tx) =>
      findFiscalYearClosing(tx, org.id, '2025-01-01'),
    );
    expect(closing).not.toBeNull();
    expect(closing?.netIncomeMinor).toBe(300_000n);
    expect(closing?.transactionId).toBe(result.transactionId);
    expect(closing?.transactionVoided).toBe(false);

    const audits = await admin`
      select action, after from audit_logs
      where organization_id = ${org.id} and action = 'fiscal_year.closed'
    `;
    expect(audits).toHaveLength(1);
    // tx.json() 存的必须是 jsonb 对象，不是 JSON 标量字符串——否则
    // after->>'periodStart' 之类的查询全部失效（见 recordAudit 的注释）。
    expect((audits[0].after as Record<string, unknown>).periodStart).toBe('2025-01-01');
  });

  it('同一财年只能结一次，第二次给出一句读得懂的话', async () => {
    await expect(
      withTransaction(userId, (tx) =>
        closeFiscalYear(
          tx,
          ctx,
          {
            period: FY2025,
            today: '2026-09-01',
            description: 'again',
            clientUuid: randomUUID(),
          },
          testPoster,
        ),
      ),
    ).rejects.toThrow(/already been closed/i);
  });
});

describe('undoFiscalYearClose', () => {
  it('删登记行 + 作废分录，三个作废字段一起写', async () => {
    const closing = await withTransaction(userId, (tx) =>
      findFiscalYearClosing(tx, org.id, '2025-01-01'),
    );
    expect(closing).not.toBeNull();

    await withTransaction(userId, (tx) =>
      undoFiscalYearClose(tx, ctx, closing!, 'closed the wrong year'),
    );

    const gone = await withTransaction(userId, (tx) =>
      getFiscalYearClosingById(tx, org.id, closing!.id),
    );
    expect(gone).toBeNull();

    const [txnRow] = await admin`
      select voided_at, voided_by, void_reason from transactions
      where id = ${closing!.transactionId}
    `;
    expect(txnRow.voided_at).not.toBeNull();
    expect(txnRow.voided_by).toBe(userId);
    expect(txnRow.void_reason).toBe('closed the wrong year');

    // 分录行保留不动——账目要可追溯。
    const lines = await admin`
      select count(*)::int as n from journal_lines where transaction_id = ${closing!.transactionId}
    `;
    expect(lines[0].n).toBe(3);

    const audits = await admin`
      select count(*)::int as n from audit_logs
      where organization_id = ${org.id} and action = 'fiscal_year.reopened'
    `;
    expect(audits[0].n).toBe(1);
  });

  it('撤销之后可以重新结转，并得到同一个净利润', async () => {
    const result = await withTransaction(userId, (tx) =>
      closeFiscalYear(
        tx,
        ctx,
        {
          period: FY2025,
          today: '2026-09-01',
          // 必须是一个新的 clientUuid：沿用旧的会让 postJournal 的幂等查询
          // 命中那笔已作废的交易，于是撤销之后再也结不上。
          clientUuid: randomUUID(),
          description: 'Year-end closing 2025 (redo)',
        },
        testPoster,
      ),
    );
    expect(result.netIncomeMinor).toBe(300_000n);

    // 上一次的分录已作废，所以 buildClosingPlan 不会把它算成「已经结过了」
    // 而少算一遍——净利润仍然是原来那个数。
    const plan = await withTransaction(userId, (tx) => buildClosingPlan(tx, ctx, FY2025));
    expect(plan.netIncomeMinor).toBe(300_000n);
  });
});
