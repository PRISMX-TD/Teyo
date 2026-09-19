import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { todayLocalISO } from '@/lib/date';
import { withTransaction } from '@/server/db/transaction';
import { getProfitLoss, getTrialBalance } from '@/server/repositories/reports';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

/**
 * 年结走**真实的记账边界**。
 *
 * tests/services/year-end-close.test.ts 测的是年结的编排逻辑（期间、幂等、
 * 登记、撤销），它用一个自己实现的 poster 直接插分录——那是刻意的替身，
 * 因为写那份测试时 server/domain/posting-templates.ts 还表达不了
 * kind = 'closing' 的 n 行分录。
 *
 * 这一份补的正是那个替身盖住的那一段：真的调 closeFiscalYear（它内部走
 * postJournal），断言落库的是一笔 kind = 'closing'、配平、不带分类的交易，
 * 并且**损益表把它排除在外而试算平衡表包含它**——后面这一条是整个设计的
 * 关键，写错了不会有任何报错，只会让刚结转过的那一年损益表变成全零。
 */

let currentUserId: string | null = null;
vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
  requireUserId: () => Promise.resolve(currentUserId),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { closeFiscalYear, undoYearEndClose } = await import('@/server/actions/year_end');

const suffix = randomUUID().slice(0, 8);
/**
 * 要结的财年。
 *
 * 必须是**上一个**财年：closeFiscalYear 只接受 previousFiscalYear(today)
 * 那一个，不允许跳年去结更早的（见 server/actions/year_end.ts 的
 * resolveRequestedFiscalYear）。跳年结转会让中间那些年的损益永远留在
 * 损益科目上，而资产负债表看起来完全正常。
 */
const FY_START = '2025-01-01';
const FY_END = '2025-12-31';

let ownerId = '';
let orgId = '';
let orgSlug = '';
let accounts: Record<string, string> = {};

/** 直接插一笔配平的交易，不经 action 层——这里要的是「有余额的损益科目」。 */
async function insertBalanced(
  occurredOn: string,
  amountMinor: bigint,
  debitAccountId: string,
  creditAccountId: string,
): Promise<void> {
  const [txn] = await admin`
    insert into transactions
      (organization_id, kind, occurred_on, description, currency,
       amount_minor, base_amount_minor, exchange_rate, category_id, created_by, client_uuid)
    values (${orgId}, 'transfer', ${occurredOn}::date, 'fixture', 'MYR',
       ${amountMinor.toString()}, ${amountMinor.toString()}, 1, null, ${ownerId}, gen_random_uuid())
    returning id
  `;
  await admin`
    insert into journal_lines
      (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
    values
      (${txn.id}, ${orgId}, ${debitAccountId}, 'debit', ${amountMinor.toString()}, ${amountMinor.toString()}),
      (${txn.id}, ${orgId}, ${creditAccountId}, 'credit', ${amountMinor.toString()}, ${amountMinor.toString()})
  `;
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-yeposting-${suffix}@example.com`, 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Year End Co', `ye-post-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  currentUserId = ownerId;

  const rows = await admin`
    select id, code from accounts where organization_id = ${orgId}
      and code in ('cash', 'sales', 'rent', 'retained-earnings')
  `;
  accounts = Object.fromEntries(rows.map((r) => [r.code as string, r.id as string]));

  // 2025 财年：收入 5000.00，费用 2000.00 → 净利润 3000.00
  await insertBalanced('2025-03-01', 500_000n, accounts.cash, accounts.sales);
  await insertBalanced('2025-06-01', 200_000n, accounts.rent, accounts.cash);
  // 本财年（2026）的一笔，绝不能被结转进去——年结只结上一个财年。
  await insertBalanced('2026-02-01', 900_000n, accounts.cash, accounts.sales);
});

afterAll(async () => {
  await resetTestData();
});

describe('closeFiscalYear 走 postJournal', () => {
  it('落成一笔 kind = closing、配平、不带分类的本位币交易', async () => {
    const { transactionId } = await closeFiscalYear(orgSlug, { periodStart: FY_START });

    const [txn] = await admin`
      select kind, occurred_on, category_id, currency, exchange_rate, rate_source,
             amount_minor, base_amount_minor
      from transactions where id = ${transactionId}
    `;

    expect(txn.kind).toBe('closing');
    // 年结记在财年最后一天。用 todayLocalISO 而不是 String(...).slice(0,10)：
    // postgres.js 把 date 列解析成 Date，String() 给出 "Tue Dec 31"。
    expect(todayLocalISO(txn.occurred_on as Date)).toBe(FY_END);
    // 0024 把 'closing' 并进了「不带分类」那一支。
    expect(txn.category_id).toBeNull();
    // 纯本位币分录，一次换算都不涉及。
    expect(txn.currency).toBe('MYR');
    expect(Number(txn.exchange_rate)).toBe(1);
    // rate_source 记 'manual' 而不是 'auto'：'auto' 的含义是「查了汇率表」，
    // 而这里一次都没查。
    expect(txn.rate_source).toBe('manual');
    // 表头金额 = 借方合计 = 被冲平的收入（5000.00）。
    expect(BigInt(txn.amount_minor as string)).toBe(500_000n);
    expect(BigInt(txn.base_amount_minor as string)).toBe(500_000n);

    const lines = await admin`
      select a.code, l.direction, l.amount_minor
      from journal_lines l join accounts a on a.id = l.account_id
      where l.transaction_id = ${transactionId}
      order by a.code
    `;
    const shape = lines.map((l) => `${l.direction}:${l.code}:${l.amount_minor}`);
    // 借收入 5000（把贷方余额冲平）/ 贷费用 2000 / 贷留存收益 3000
    expect(shape.sort()).toEqual(
      ['debit:sales:500000', 'credit:rent:200000', 'credit:retained-earnings:300000'].sort(),
    );

    // 配平——数据库的延迟触发器提交时也验过一遍，这里再从数据侧确认。
    const debit = lines
      .filter((l) => l.direction === 'debit')
      .reduce((s, l) => s + BigInt(l.amount_minor as string), 0n);
    const credit = lines
      .filter((l) => l.direction === 'credit')
      .reduce((s, l) => s + BigInt(l.amount_minor as string), 0n);
    expect(debit).toBe(credit);
  });

  it('损益表排除年结，试算平衡表包含它', async () => {
    const { pl, tb } = await withTransaction(ownerId, async (tx) => ({
      pl: await getProfitLoss(tx, orgId, FY_START, FY_END),
      tb: await getTrialBalance(tx, orgId, FY_END),
    }));

    // 这是整个设计的关键一条：年结恰好把当年的收入费用科目冲平，损益表
    // 若把它算进去，那一年的损益表会变成全零——用户第二年回头看去年的
    // 损益表，会看到一张什么都没有的表。
    expect(pl.netIncome).toBe(300_000n);

    // 试算平衡表必须包含它：留存收益的余额正是靠这笔分录来的。
    const retained = tb.find((row) => row.code === 'retained-earnings');
    expect(retained).toBeDefined();
    expect(retained!.creditMinor - retained!.debitMinor).toBe(300_000n);

    // 试算平衡表自身仍然平。
    const totalDebit = tb.reduce((s, r) => s + r.debitMinor, 0n);
    const totalCredit = tb.reduce((s, r) => s + r.creditMinor, 0n);
    expect(totalDebit).toBe(totalCredit);
  });

  it('同一个财年不能结第二次', async () => {
    await expect(closeFiscalYear(orgSlug, { periodStart: FY_START })).rejects.toThrow();
  });

  it('撤销之后可以重新结转，而且不会撞幂等键', async () => {
    const [closing] = await admin`
      select id from fiscal_year_closings
      where organization_id = ${orgId} and period_start = ${FY_START}::date
    `;

    await undoYearEndClose(orgSlug, {
      closingId: closing.id as string,
      reason: 'Re-closing after a correction',
    });

    // 登记行没了，那笔交易被软删除（账本不删行）。
    const remaining = await admin`
      select count(*)::int as n from fiscal_year_closings
      where organization_id = ${orgId} and period_start = ${FY_START}::date
    `;
    expect(remaining[0].n).toBe(0);

    const voided = await admin`
      select count(*)::int as n from transactions
      where organization_id = ${orgId} and kind = 'closing' and voided_at is not null
    `;
    expect(voided[0].n).toBe(1);

    // 重新结转必须成功。撤销重做时 clientUuid 必须是一个新的键——沿用旧键
    // 会让 postJournal 的幂等查询命中那笔已作废的交易，直接返回
    // deduplicated，于是撤销之后再也结不上（而且没有任何报错）。
    const again = await closeFiscalYear(orgSlug, { periodStart: FY_START });
    expect(again.transactionId).toBeTruthy();

    const active = await admin`
      select count(*)::int as n from transactions
      where organization_id = ${orgId} and kind = 'closing' and voided_at is null
    `;
    expect(active[0].n).toBe(1);
  });
});
