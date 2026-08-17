import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { toIsoDate } from '@/lib/format';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
  seedRate,
  type SeededOrg,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createRecurring, generateDueRecurring } = await import('@/server/actions/recurring');

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

/**
 * 每一行分录落在哪个科目的哪一边，按交易日期排序。
 *
 * 只断言金额是不够的：把 toAccountId / fromAccountId 写反，一借一贷照样配平，
 * templateFor 只拦借贷同科目，insertJournalLines 只查科目归属，数据库的配平
 * 触发器只比合计——每一笔转账都反了，金额却一分不差。要拦住这种改动，断言
 * 必须说出「哪个科目在借方」。
 */
async function linesByAccount(orgId: string) {
  const rows = await admin`
    select t.kind, t.occurred_on, l.direction, a.code
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    join accounts a on a.id = l.account_id
    where l.organization_id = ${orgId}
    order by t.occurred_on asc, l.direction asc
  `;
  return rows.map((r) => [r.kind, r.direction, r.code]);
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
      select l.direction, l.amount_minor, l.base_amount_minor, a.code
      from journal_lines l
      join accounts a on a.id = l.account_id
      where l.organization_id = ${org.id}
      order by l.direction
    `;
    // direction 是枚举列，order by 走的是声明顺序（debit 在前），不是字典序。
    // 费用规则：借费用科目、贷资金账户——科目也要断言，光断言金额挡不住方向写反。
    expect(lines).toEqual([
      { direction: 'debit', code: 'ai-llm-costs', amount_minor: '10000', base_amount_minor: '47000' },
      { direction: 'credit', code: 'bank', amount_minor: '10000', base_amount_minor: '47000' },
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
    expect(report.blocked[0].occurredOn).toBe('2026-04-10');
    expect(report.blocked[0].reason).toMatch(/exchange rate/i);
    // 「LedgerError」这类内部名字不该出现在用户看到的句子里。
    expect(report.blocked[0].reason).not.toMatch(/Error/);

    expect(await transactionsOf(org.id)).toHaveLength(0);
    // 整条规则连同它的 next_due_date 推进一起回滚了。
    expect(await nextDueOf(ruleId)).toBe('2026-04-10');
  });
});

describe('generateDueRecurring - 四种 kind 各自的借贷方向', () => {
  it('每种 kind 的借方科目与贷方科目都落在规则指定的那一侧', async () => {
    const org = await freshOrg('Mapping');

    // 规则表存的是字面的借方/贷方，PostingEvent 的四个变体各用不同的字段名
    // 表达同一对方向。写反不会报任何错，只会让每一笔都记反，所以这里逐个钉住。
    await insertRule({
      orgId: org.id,
      kind: 'expense',
      description: 'Rent',
      debitAccountId: org.accountsByCode.rent,
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode.rent,
      nextDueDate: '2026-02-01',
      endDate: '2026-02-01',
    });
    await insertRule({
      orgId: org.id,
      kind: 'income',
      description: 'Retainer',
      debitAccountId: org.accountsByCode.bank,
      creditAccountId: org.accountsByCode.sales,
      categoryId: org.categoriesByAccountCode.sales,
      nextDueDate: '2026-02-02',
      endDate: '2026-02-02',
    });
    await insertRule({
      orgId: org.id,
      kind: 'transfer',
      description: 'Cash to bank sweep',
      debitAccountId: org.accountsByCode.bank, // 转入方 = 借方
      creditAccountId: org.accountsByCode.cash, // 转出方 = 贷方
      nextDueDate: '2026-02-03',
      endDate: '2026-02-03',
    });
    await insertRule({
      orgId: org.id,
      kind: 'journal',
      description: 'Equipment accrual',
      debitAccountId: org.accountsByCode.equipment,
      creditAccountId: org.accountsByCode['accounts-payable'],
      nextDueDate: '2026-02-04',
      endDate: '2026-02-04',
    });

    const report = await generateDueRecurring(org.slug);
    expect(report.blocked).toEqual([]);
    expect(report.generated).toBe(4);

    expect(await linesByAccount(org.id)).toEqual([
      ['expense', 'debit', 'rent'],
      ['expense', 'credit', 'bank'],
      ['income', 'debit', 'bank'],
      ['income', 'credit', 'sales'],
      // 最容易写反的一条：to 是借方。整个计划里已经有一次把它写反的记录。
      ['transfer', 'debit', 'bank'],
      ['transfer', 'credit', 'cash'],
      ['journal', 'debit', 'equipment'],
      ['journal', 'credit', 'accounts-payable'],
    ]);

    // 转账与手工凭证不挂分类，收支必须挂。
    const kinds = await admin`
      select kind, category_id from transactions
      where organization_id = ${org.id} order by occurred_on asc
    `;
    expect(kinds.map((r) => [r.kind, r.category_id === null])).toEqual([
      ['expense', false],
      ['income', false],
      ['transfer', true],
      ['journal', true],
    ]);
  });
});

describe('createRecurring', () => {
  it('带结束日期的规则建得出来，并且只生成到结束日期为止', async () => {
    // insertRecurring 原先把 ::date 拼在插值里面，绑定参数的值成了字符串
    // '2026-04-20::date'，postgres.js 按 date 序列化时直接抛 Invalid time value。
    // 于是带结束日期的规则在生产里根本建不出来——而本任务的补记逻辑一半都
    // 建立在结束日期上。
    expect(TODAY > '2026-04-20').toBe(true);

    const org = await freshOrg('CreateEnd');
    const { id } = await createRecurring(org.slug, {
      kind: 'expense',
      description: 'Bounded rent',
      amount: '750.00',
      currency: 'MYR',
      debitAccountId: org.accountsByCode.rent,
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode.rent,
      frequency: 'monthly',
      interval: 1,
      startDate: '2026-03-20',
      endDate: '2026-04-20',
    });

    const [row] = await admin`
      select start_date, end_date, next_due_date
      from recurring_transactions where id = ${id}
    `;
    expect(toIsoDate(row.start_date as Date)).toBe('2026-03-20');
    expect(toIsoDate(row.end_date as Date)).toBe('2026-04-20');
    expect(toIsoDate(row.next_due_date as Date)).toBe('2026-03-20');

    const report = await generateDueRecurring(org.slug);
    expect(report.generated).toBe(2);
    expect(report.blocked).toEqual([]);

    const rows = await transactionsOf(org.id);
    expect(rows.map((r) => toIsoDate(r.occurred_on as Date))).toEqual([
      '2026-03-20',
      '2026-04-20',
    ]);
  });

  it('拒绝 interval 为 0 的规则', async () => {
    const org = await freshOrg('BadInterval');
    await expect(
      createRecurring(org.slug, {
        kind: 'expense',
        description: 'Zero interval',
        amount: '10.00',
        currency: 'MYR',
        debitAccountId: org.accountsByCode.rent,
        creditAccountId: org.accountsByCode.bank,
        categoryId: org.categoriesByAccountCode.rent,
        frequency: 'monthly',
        interval: 0,
        startDate: '2026-03-01',
      }),
    ).rejects.toThrow(/at least 1/i);

    const rules = await admin`
      select id from recurring_transactions where organization_id = ${org.id}
    `;
    expect(rules).toHaveLength(0);
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

describe('generateDueRecurring - 一条规则内部也不是全有全无', () => {
  it('中间某一期缺汇率时，之前几期留在账上，游标停在卡住的那一天', async () => {
    expect(TODAY > '2026-05-12').toBe(true);

    const org = await freshOrg('PartialFX');
    // 前两期有汇率，第三期没有。findRate 只回溯 7 天，所以 04-12 那条不会被
    // 05-12 借用。这正是现实里最常见的形状：Cron 只同步「今天」，任何在规则
    // 起始日之后才开始用这个应用的公司，历史汇率天然是断的。
    await seedRate('NZD', 'MYR', 2_60000000n, '2026-03-12');
    await seedRate('NZD', 'MYR', 2_65000000n, '2026-04-12');

    const ruleId = await insertRule({
      orgId: org.id,
      description: 'NZD subscription',
      amount: '80.00',
      currency: 'NZD',
      debitAccountId: org.accountsByCode['ai-llm-costs'],
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode['ai-llm-costs'],
      frequency: 'monthly',
      startDate: '2026-03-12',
      nextDueDate: '2026-03-12',
      endDate: '2026-05-12',
    });

    const report = await generateDueRecurring(org.slug);

    // 逐期保存点之前：第三期一失败，前两期连同游标推进一起回滚，这条规则
    // 每次运行都从 03-12 重来、每次都在 05-12 倒下，永远一笔都记不进去。
    expect(report.generated).toBe(2);
    expect(report.deferred).toEqual([]);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].occurredOn).toBe('2026-05-12');
    expect(report.blocked[0].reason).toMatch(/exchange rate/i);

    const rows = await transactionsOf(org.id);
    expect(rows.map((r) => toIsoDate(r.occurred_on as Date))).toEqual([
      '2026-03-12',
      '2026-04-12',
    ]);
    // 80.00 NZD x 2.60 / x 2.65
    expect(rows.map((r) => r.base_amount_minor)).toEqual(['20800', '21200']);

    // 游标停在卡住的那一期，不多不少：补上那天的汇率就能接着往下走。
    expect(await nextDueOf(ruleId)).toBe('2026-05-12');
  });

  it('interval 为 0 的存量规则被挡下，而不是把同一天记满 60 笔', async () => {
    const org = await freshOrg('ZeroInterval');
    // 直接写库，绕过 createRecurring 的校验：0019 迁移落地前，库里可能已经
    // 存在这样的行。
    const ruleId = await insertRule({
      orgId: org.id,
      description: 'Zero interval rent',
      amount: '1200.00',
      debitAccountId: org.accountsByCode.rent,
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode.rent,
      frequency: 'monthly',
      interval: 0,
      nextDueDate: '2026-03-01',
    });

    const report = await generateDueRecurring(org.slug);

    expect(report.generated).toBe(0);
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0].occurredOn).toBeNull();
    expect(report.blocked[0].reason).toMatch(/at least 1/i);
    // 断言的重点不是「没记」，而是「没记 60 遍」：RM1,200 的房租
    // 会变成 RM72,000，而且借贷完全配平，触发器一点都看不出来。
    expect(await transactionsOf(org.id)).toHaveLength(0);
    expect(await nextDueOf(ruleId)).toBe('2026-03-01');
  });
});

describe('generateDueRecurring - 角色', () => {
  it('bookkeeper 得到一句说明该找谁的话，而不是每条规则一句「出了点问题」', async () => {
    const org = await freshOrg('Bookkeeper');
    await insertRule({
      orgId: org.id,
      description: 'Rule one',
      debitAccountId: org.accountsByCode.rent,
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode.rent,
      nextDueDate: '2026-03-01',
      endDate: '2026-03-01',
    });
    await insertRule({
      orgId: org.id,
      description: 'Rule two',
      debitAccountId: org.accountsByCode.utilities,
      creditAccountId: org.accountsByCode.bank,
      categoryId: org.categoriesByAccountCode.utilities,
      nextDueDate: '2026-03-02',
      endDate: '2026-03-02',
    });

    const bookkeeperId = await createTestUser(
      `test-bk-recurgen-${suffix}@example.com`,
      'Bookkeeper',
    );
    await joinOrg(bookkeeperId, org.id, 'bookkeeper');

    currentUserId = bookkeeperId;
    try {
      // bookkeeper 有 transaction:create，所以过得了 requirePermission；但
      // recurring_transactions 的 RLS 写入策略只认 owner/admin，推进
      // next_due_date 那句 UPDATE 一定会被拒。不先判角色的话，每条规则都会
      // 在保存点里撞上同一个原始 Postgres 错误，用户连着看到两句
      // 「Something went wrong with this rule」，一句都没说到底为什么。
      await expect(generateDueRecurring(org.slug)).rejects.toThrow(/owner or an admin/i);
    } finally {
      currentUserId = ownerId;
    }

    expect(await transactionsOf(org.id)).toHaveLength(0);

    // owner 跑同一批就正常。
    const report = await generateDueRecurring(org.slug);
    expect(report.generated).toBe(2);
    expect(report.blocked).toEqual([]);
  });
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
    expect(report.blocked[0].occurredOn).toBe('2026-03-01');
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
    expect(report.blocked[0].occurredOn).toBe('2026-03-03');
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
