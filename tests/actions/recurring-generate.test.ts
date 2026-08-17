import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { toIsoDate } from '@/lib/format';
import {
  createTestOrgWithSeed,
  createTestUser,
  resetTestData,
  seedRate,
  type SeededOrg,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { generateDueRecurring } = await import('@/server/actions/recurring');

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let orgSeq = 0;

/**
 * generateDueRecurring 一次处理整家公司所有到期的规则，所以每个用例各开一家
 * 公司：否则前一个用例遗留的规则会混进后一个用例的统计里，断言就再也说不清
 * 到底是谁生成的。
 */
async function freshOrg(label: string): Promise<SeededOrg> {
  orgSeq += 1;
  return createTestOrgWithSeed(ownerId, `Recur ${label}`, `recur-${suffix}-${orgSeq}`, 'MYR');
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-recurgen-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

// 生成用的「今天」取自真实时钟（server/actions/recurring.ts 里的
// new Date()），测试无法注入，所以到期日一律相对今天算，或者用 end_date
// 把occurrence 数量钉死。
const TODAY = new Date().toISOString().slice(0, 10);

function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

type RuleFields = {
  orgId: string;
  kind?: 'income' | 'expense' | 'transfer' | 'journal';
  description: string;
  amount?: string;
  currency?: string;
  debitAccountId: string;
  creditAccountId: string;
  categoryId?: string | null;
  frequency?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  interval?: number;
  startDate?: string;
  endDate?: string | null;
  nextDueDate: string;
};

/** admin 连接绕过 RLS，直接把规则写成用例需要的样子。 */
async function insertRule(fields: RuleFields): Promise<string> {
  const [row] = await admin`
    insert into recurring_transactions
      (organization_id, kind, description, amount, currency,
       debit_account_id, credit_account_id, category_id,
       frequency, "interval", start_date, end_date, next_due_date)
    values (
      ${fields.orgId},
      ${fields.kind ?? 'expense'},
      ${fields.description},
      ${fields.amount ?? '100.00'},
      ${fields.currency ?? 'MYR'},
      ${fields.debitAccountId},
      ${fields.creditAccountId},
      ${fields.categoryId ?? null},
      ${fields.frequency ?? 'monthly'},
      ${fields.interval ?? 1},
      ${fields.startDate ?? fields.nextDueDate}::date,
      ${fields.endDate ?? null}::date,
      ${fields.nextDueDate}::date
    )
    returning id
  `;
  return row.id as string;
}

async function transactionsOf(orgId: string) {
  return admin`
    select occurred_on, currency, amount_minor, base_amount_minor,
           exchange_rate, rate_source, kind, category_id, description
    from transactions
    where organization_id = ${orgId}
    order by occurred_on asc
  `;
}

async function nextDueOf(ruleId: string): Promise<string> {
  const [row] = await admin`
    select next_due_date from recurring_transactions where id = ${ruleId}
  `;
  return toIsoDate(row.next_due_date as Date);
}

describe('generateDueRecurring - 外币规则', () => {
  it('有缓存汇率时按真实汇率入账（这条路径此前从未跑通过）', async () => {
    const org = await freshOrg('FX');
    // EUR 在别的测试文件里只用在 2031 年；findRate 只回溯 7 天，互不干扰。
    await seedRate('EUR', 'MYR', 4_70000000n, '2026-03-10');

    const ruleId = await insertRule({
      orgId: org.id,
      description: 'EUR hosting',
      amount: '100.00',
      currency: 'EUR',
      debitAccountId: org.accountsByCode['ai-llm-costs'],
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode['ai-llm-costs'],
      nextDueDate: '2026-03-10',
      endDate: '2026-03-10',
    });

    const report = await generateDueRecurring(org.slug);

    expect(report.generated).toBe(1);
    expect(report.blocked).toEqual([]);
    expect(report.deferred).toEqual([]);

    const [txn] = await transactionsOf(org.id);
    expect(txn.currency).toBe('EUR');
    expect(txn.amount_minor).toBe('10000');
    // 100.00 EUR x 4.70 = 470.00 MYR。改之前这里会是 100.00 MYR。
    expect(txn.base_amount_minor).toBe('47000');
    expect(Number(txn.exchange_rate)).toBe(4.7);
    expect(txn.rate_source).toBe('auto');
    expect(toIsoDate(txn.occurred_on as Date)).toBe('2026-03-10');

    const lines = await admin`
      select direction, amount_minor, base_amount_minor
      from journal_lines
      where organization_id = ${org.id}
      order by direction
    `;
    // direction 是枚举列，order by 走的是声明顺序（debit 在前），不是字典序。
    expect(lines).toEqual([
      { direction: 'debit', amount_minor: '10000', base_amount_minor: '47000' },
      { direction: 'credit', amount_minor: '10000', base_amount_minor: '47000' },
    ]);

    // 单期规则跑完后就不该再到期。
    expect(await nextDueOf(ruleId)).toBe('2026-04-10');
  });

  it('没有缓存汇率时挡下这条规则，而不是按 1:1 记账', async () => {
    const org = await freshOrg('NoRate');
    // CHF 没有任何测试写过汇率。
    const ruleId = await insertRule({
      orgId: org.id,
      description: 'CHF retainer',
      amount: '250.00',
      currency: 'CHF',
      debitAccountId: org.accountsByCode['professional-fees'],
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode['professional-fees'],
      nextDueDate: '2026-04-10',
      endDate: '2026-04-10',
    });

    const report = await generateDueRecurring(org.slug);

    expect(report.generated).toBe(0);
    expect(report.deferred).toEqual([]);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].description).toBe('CHF retainer');
    expect(report.blocked[0].reason).toMatch(/exchange rate/i);
    // 「LedgerError」这类内部名字不该出现在用户看到的句子里。
    expect(report.blocked[0].reason).not.toMatch(/Error/);

    expect(await transactionsOf(org.id)).toHaveLength(0);
    // 整条规则连同它的 next_due_date 推进一起回滚了。
    expect(await nextDueOf(ruleId)).toBe('2026-04-10');
  });
});

describe('generateDueRecurring - 补记积压', () => {
  it('逾期三期生成三笔，每笔各记在自己的到期日上', async () => {
    const org = await freshOrg('CatchUp');
    const ruleId = await insertRule({
      orgId: org.id,
      description: 'Daily coffee',
      amount: '12.50',
      currency: 'MYR',
      debitAccountId: org.accountsByCode['other-expenses'],
      creditAccountId: org.accountsByCode.cash,
      categoryId: org.categoriesByAccountCode['other-expenses'],
      frequency: 'daily',
      nextDueDate: shiftDays(TODAY, -2),
    });

    const report = await generateDueRecurring(org.slug);
    expect(report.generated).toBe(3);
    expect(report.blocked).toEqual([]);

    const rows = await transactionsOf(org.id);
    expect(rows.map((r) => toIsoDate(r.occurred_on as Date))).toEqual([
      shiftDays(TODAY, -2),
      shiftDays(TODAY, -1),
      TODAY,
    ]);
    // 改之前这三笔全都记在今天，前两天的损益表里一分钱都看不到。
    expect(rows.every((r) => r.amount_minor === '1250')).toBe(true);

    expect(await nextDueOf(ruleId)).toBe(shiftDays(TODAY, 1));
  });

  it('结束日期已经过去的规则仍然补齐它欠下的那几期，且不越过结束日期', async () => {
    // 用 end_date 把期数钉死，用例因此不随运行日期改变（只要今天晚于
    // 2026-05-15，而这个仓库的时间线本就在那之后）。
    expect(TODAY > '2026-05-15').toBe(true);

    const org = await freshOrg('Ended');
    const ruleId = await insertRule({
      orgId: org.id,
      description: 'Shop rent',
      amount: '1200.00',
      currency: 'MYR',
      debitAccountId: org.accountsByCode.rent,
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode.rent,
      frequency: 'monthly',
      startDate: '2026-03-15',
      nextDueDate: '2026-03-15',
      endDate: '2026-05-15',
    });

    const report = await generateDueRecurring(org.slug);

    // 改之前 getDueRecurring 的 end_date >= today 过滤会把整条规则排除掉，
    // 这三笔房租永远不会生成，界面上也不会有任何提示。
    expect(report.generated).toBe(3);
    expect(report.blocked).toEqual([]);
    expect(report.deferred).toEqual([]);

    const rows = await transactionsOf(org.id);
    expect(rows.map((r) => toIsoDate(r.occurred_on as Date))).toEqual([
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
    ]);

    // 游标停在 end_date 之后的那一期，此后这条规则再也不会被选中。
    expect(await nextDueOf(ruleId)).toBe('2026-06-15');
    const second = await generateDueRecurring(org.slug);
    expect(second.generated).toBe(0);
    expect(await transactionsOf(org.id)).toHaveLength(3);
  });

  it('撞到单次上限时把余下的期数报告成 deferred，下一次接着补', async () => {
    const org = await freshOrg('Cap');
    const ruleId = await insertRule({
      orgId: org.id,
      description: 'Daily parking',
      amount: '5.00',
      currency: 'MYR',
      debitAccountId: org.accountsByCode.transport,
      creditAccountId: org.accountsByCode.cash,
      categoryId: org.categoriesByAccountCode.transport,
      frequency: 'daily',
      nextDueDate: shiftDays(TODAY, -70),
    });

    const first = await generateDueRecurring(org.slug);
    expect(first.generated).toBe(60);
    expect(first.blocked).toEqual([]);
    expect(first.deferred).toHaveLength(1);
    expect(first.deferred[0].description).toBe('Daily parking');
    expect(first.deferred[0].resumeFrom).toBe(shiftDays(TODAY, -10));
    expect(await nextDueOf(ruleId)).toBe(shiftDays(TODAY, -10));

    // 「还欠着」和「补完了」必须分得出来：第二轮补齐剩下的 11 期，
    // 这一次 deferred 是空的。
    const second = await generateDueRecurring(org.slug);
    expect(second.generated).toBe(11);
    expect(second.deferred).toEqual([]);
    expect(await transactionsOf(org.id)).toHaveLength(71);
    expect(await nextDueOf(ruleId)).toBe(shiftDays(TODAY, 1));
    // 71 笔分录、每笔六七次往返，对着远端库跑就是几十秒——这正是上限存在的
    // 理由，也是它不能再往上调的理由。
  }, 180_000);
});

describe('generateDueRecurring - 一条坏规则不拖垮整批', () => {
  it('借贷同一个科目的规则被挡下，同一批里健康的规则照常入账', async () => {
    const org = await freshOrg('Savepoint');

    const brokenId = await insertRule({
      orgId: org.id,
      description: 'Broken wash entry',
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.cash,
      categoryId: org.categoriesByAccountCode.rent,
      nextDueDate: '2026-03-01',
      endDate: '2026-03-01',
    });
    const healthyId = await insertRule({
      orgId: org.id,
      description: 'Healthy utilities',
      amount: '300.00',
      debitAccountId: org.accountsByCode.utilities,
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode.utilities,
      nextDueDate: '2026-03-02',
      endDate: '2026-03-02',
    });

    const report = await generateDueRecurring(org.slug);

    expect(report.generated).toBe(1);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].description).toBe('Broken wash entry');
    expect(report.blocked[0].reason).toMatch(/different accounts/i);

    const rows = await transactionsOf(org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Healthy utilities');

    // 坏规则整条回滚，健康规则照常推进。
    expect(await nextDueOf(brokenId)).toBe('2026-03-01');
    expect(await nextDueOf(healthyId)).toBe('2026-04-02');
  });

  it('不挂分类的收入规则被挡下，理由是一句人话而不是数据库报错', async () => {
    const org = await freshOrg('NoCategory');

    const blockedId = await insertRule({
      orgId: org.id,
      kind: 'income',
      description: 'Uncategorised income',
      amount: '900.00',
      debitAccountId: org.accountsByCode.bank,
      creditAccountId: org.accountsByCode.sales,
      categoryId: null,
      nextDueDate: '2026-03-03',
      endDate: '2026-03-03',
    });
    await insertRule({
      orgId: org.id,
      kind: 'income',
      description: 'Categorised income',
      amount: '400.00',
      debitAccountId: org.accountsByCode.bank,
      creditAccountId: org.accountsByCode.sales,
      categoryId: org.categoriesByAccountCode.sales,
      nextDueDate: '2026-03-04',
      endDate: '2026-03-04',
    });

    const report = await generateDueRecurring(org.slug);

    expect(report.generated).toBe(1);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].description).toBe('Uncategorised income');
    expect(report.blocked[0].reason).toBe('Income and expense records need a category.');
    // 数据库那条 CHECK 约束的原文长这样，不该漏到界面上。
    expect(report.blocked[0].reason).not.toMatch(/constraint|violates/i);

    const rows = await transactionsOf(org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Categorised income');
    expect(await nextDueOf(blockedId)).toBe('2026-03-03');
  });
});

describe('generateDueRecurring - 并发', () => {
  it('两次同时运行只入账一次', async () => {
    const org = await freshOrg('Concurrent');
    const ruleId = await insertRule({
      orgId: org.id,
      description: 'Concurrent rent',
      amount: '800.00',
      debitAccountId: org.accountsByCode.rent,
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode.rent,
      nextDueDate: '2026-03-05',
      endDate: '2026-03-05',
    });

    // 没有 for update 时，两边都读到这条规则、都入账，第二次的 UPDATE 只是
    // 阻塞一下再照常写入——不报错，账上多一笔。两个浏览器标签页就够触发。
    const [a, b] = await Promise.all([
      generateDueRecurring(org.slug),
      generateDueRecurring(org.slug),
    ]);

    expect(a.generated + b.generated).toBe(1);
    expect(await transactionsOf(org.id)).toHaveLength(1);
    expect(await nextDueOf(ruleId)).toBe('2026-04-05');
  });
});
