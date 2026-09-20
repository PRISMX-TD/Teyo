import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import type { OrgContext } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { postJournal } from '@/server/posting/post-journal';
import { getTaxReport } from '@/server/repositories/tax';
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

const { getTaxReportAction } = await import('@/server/actions/tax');

const suffix = randomUUID().slice(0, 8);

let ownerId: string;

const FROM = '2026-01-01';
const TO = '2026-03-31';
const ON = '2026-02-01';

type Org = SeededOrg & { ctx: OrgContext };

/**
 * 每个用例一家自己的公司。
 *
 * 税务报表量的是「整个期间的合计」，不是某一笔单据，所以断言只有在这家公司
 * 里除了本用例造的数据之外一笔都没有时才说得上是绝对值。共用一家公司的话，
 * 每加一个用例就得回去改前面所有用例的期望数字。
 */
async function newOrg(name: string): Promise<Org> {
  const org = await createTestOrgWithSeed(ownerId, name, `tax-${name}-${suffix}`, 'MYR');
  return {
    ...org,
    ctx: {
      userId: ownerId,
      organizationId: org.id,
      orgSlug: org.slug,
      role: 'owner',
      baseCurrency: 'MYR',
      lockedUntil: null,
      timezone: 'Asia/Kuala_Lumpur',
    },
  };
}

/** 开一张含税发票：借应收（总额）/ 贷销售收入（净额）/ 贷销项税（税额）。 */
function postInvoice(
  org: Org,
  args: { net: bigint; tax: bigint; occurredOn?: string; currency?: string; manualRate?: string },
) {
  return withTransaction(ownerId, (tx) =>
    postJournal(tx, org.ctx, {
      event: {
        type: 'invoice',
        receivableAccountId: org.accountsByCode['accounts-receivable'],
        revenueAccountId: org.accountsByCode.sales,
        taxAccountId: org.accountsByCode['tax-payable'],
        netMinor: args.net,
        taxMinor: args.tax,
        amountMinor: args.net + args.tax,
      },
      occurredOn: args.occurredOn ?? ON,
      description: 'Invoice',
      currency: args.currency ?? 'MYR',
      manualRate: args.manualRate,
      manualRateEntry: 'available',
      categoryId: null,
      clientUuid: randomUUID(),
    }),
  );
}

/** 收一张含税账单：借费用（净额）/ 借进项税（税额）/ 贷应付（总额）。 */
function postBill(
  org: Org,
  args: { net: bigint; tax: bigint; occurredOn?: string; currency?: string; manualRate?: string },
) {
  return withTransaction(ownerId, (tx) =>
    postJournal(tx, org.ctx, {
      event: {
        type: 'bill',
        payableAccountId: org.accountsByCode['accounts-payable'],
        expenseAccountId: org.accountsByCode.purchases,
        taxAccountId: org.accountsByCode['tax-receivable'],
        netMinor: args.net,
        taxMinor: args.tax,
        amountMinor: args.net + args.tax,
      },
      occurredOn: args.occurredOn ?? ON,
      description: 'Bill',
      currency: args.currency ?? 'MYR',
      manualRate: args.manualRate,
      manualRateEntry: 'available',
      categoryId: null,
      clientUuid: randomUUID(),
    }),
  );
}

/** 开一张贷项通知单（销售退回）：借收入 / 借销项税 / 贷应收。发票的完全反向。 */
function postCreditNote(org: Org, args: { net: bigint; tax: bigint; occurredOn?: string }) {
  return withTransaction(ownerId, (tx) =>
    postJournal(tx, org.ctx, {
      event: {
        type: 'credit-note',
        receivableAccountId: org.accountsByCode['accounts-receivable'],
        revenueAccountId: org.accountsByCode.sales,
        taxAccountId: org.accountsByCode['tax-payable'],
        netMinor: args.net,
        taxMinor: args.tax,
        amountMinor: args.net + args.tax,
      },
      occurredOn: args.occurredOn ?? ON,
      description: 'Credit note',
      currency: 'MYR',
      manualRateEntry: 'available',
      categoryId: null,
      clientUuid: randomUUID(),
    }),
  );
}

/** 手工凭证：借待缴税款 / 贷银行——向税局缴税。 */
function postTaxRemittance(org: Org, amountMinor: bigint) {
  return withTransaction(ownerId, (tx) =>
    postJournal(tx, org.ctx, {
      event: {
        type: 'journal',
        debitAccountId: org.accountsByCode['tax-payable'],
        creditAccountId: org.accountsByCode.bank,
        amountMinor,
      },
      occurredOn: ON,
      description: 'Pay SST to the tax office',
      currency: 'MYR',
      manualRateEntry: 'unavailable',
      categoryId: null,
      clientUuid: randomUUID(),
    }),
  );
}

function report(org: Org, from = FROM, to = TO) {
  return withTransaction(ownerId, (tx) => getTaxReport(tx, org.id, from, to));
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-tax-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('getTaxReport - 进项税不再恒为 0', () => {
  // 原来进项那一段写死 `0::bigint as tax_minor`（bills 表当时没有税额列），
  // 净额取的还是 total_minor（含税总额）。后果是「应缴税款 = 销项 - 进项」
  // 这句话在这个产品里无法成立：用户看到的应缴税额永远偏高，高出来的正好
  // 是他本可以抵扣的全部进项。
  it('销项、进项、应缴税款三个数都对', async () => {
    const org = await newOrg('basic');

    await postInvoice(org, { net: 200000n, tax: 12000n }); // 卖 2000.00 + 6% SST
    await postInvoice(org, { net: 100000n, tax: 6000n });
    await postBill(org, { net: 150000n, tax: 9000n }); // 买 1500.00 + 6% SST

    const result = await report(org);

    expect(result.outputTax.netMinor).toBe(300000n);
    expect(result.outputTax.taxMinor).toBe(18000n);
    // 旧写法给 0。
    expect(result.inputTax.taxMinor).toBe(9000n);
    // 旧写法给 159000（含税总额）。
    expect(result.inputTax.netMinor).toBe(150000n);
    expect(result.netPayableMinor).toBe(9000n);
  });

  // 销售退回会冲减销项税，但它在 invoices 表里根本没有行——按单据聚合时
  // 无论怎么补状态过滤都看不见它。分录里它是「借收入 / 借销项税 / 贷应收」。
  it('贷项通知单冲减销项，而不是被漏掉', async () => {
    const org = await newOrg('credit');

    await postInvoice(org, { net: 100000n, tax: 6000n });
    await postCreditNote(org, { net: 30000n, tax: 1800n });

    const result = await report(org);
    expect(result.outputTax.netMinor).toBe(70000n);
    expect(result.outputTax.taxMinor).toBe(4200n);
  });

  // 缴税给税局（借待缴税款 / 贷银行）让 tax-payable 余额减少，但它不是一笔
  // 销售退回，不该冲减本期销项。并进 taxMinor 会让缴过税的月份销项凭空变小；
  // 直接丢掉又等于静默吞掉一笔真实发生的科目变动。所以单列。
  it('向税局缴税单列在 unmatched，不冲减销项', async () => {
    const org = await newOrg('remit');

    await postInvoice(org, { net: 100000n, tax: 6000n });
    await postTaxRemittance(org, 6000n);

    const result = await report(org);
    expect(result.outputTax.taxMinor).toBe(6000n);
    // 借方 6000 -> 贷方口径的净发生额是 -6000。
    expect(result.outputTax.unmatchedTaxMinor).toBe(-6000n);

    // 不变量：taxMinor + unmatchedTaxMinor 恒等于该税科目本期的净发生额，
    // 所以没有一分钱被静默吞掉。
    const [account] = await admin`
      select coalesce(sum(
        case when l.direction = 'credit' then l.base_amount_minor else -l.base_amount_minor end
      ), 0) as movement
      from journal_lines l
      join accounts a on a.id = l.account_id
      join transactions t on t.id = l.transaction_id
      where l.organization_id = ${org.id}
        and a.code = 'tax-payable'
        and t.voided_at is null
    `;
    expect(result.outputTax.taxMinor + result.outputTax.unmatchedTaxMinor).toBe(
      BigInt(account.movement as string),
    );
  });

  // 税表读的是账，就该以账的作废标记为准。按单据聚合时作废有两个字段
  // （invoices.voided_at 与 transactions.voided_at），两者可能不同步。
  it('作废的交易被排除', async () => {
    const org = await newOrg('voided');

    await postInvoice(org, { net: 100000n, tax: 6000n });
    const dropped = await postInvoice(org, { net: 900000n, tax: 54000n });
    // transactions_void_fields_together（0001）要求作废三字段同时存在。
    await admin`
      update transactions
      set voided_at = now(), voided_by = ${ownerId}, void_reason = 'test void'
      where id = ${dropped.transactionId}
    `;

    const result = await report(org);
    expect(result.outputTax.taxMinor).toBe(6000n);
    expect(result.outputTax.netMinor).toBe(100000n);
  });

  // 闭区间 [from, to]，与 reports.ts 的 getProfitLoss 一致。差一天就会出现
  // 「税表上的销售额与损益表上的收入对不上」。
  it('期间是闭区间，两端当天都算在内', async () => {
    const org = await newOrg('range');

    await postInvoice(org, { net: 10000n, tax: 600n, occurredOn: '2026-01-01' });
    await postInvoice(org, { net: 20000n, tax: 1200n, occurredOn: '2026-03-31' });
    await postInvoice(org, { net: 40000n, tax: 2400n, occurredOn: '2026-04-01' });

    expect((await report(org)).outputTax.taxMinor).toBe(1800n);
    expect((await report(org, '2026-01-02', '2026-03-30')).outputTax.taxMinor).toBe(0n);
    expect((await report(org, '2026-01-01', '2026-12-31')).outputTax.taxMinor).toBe(4200n);
  });

  it('一笔税都没有的公司给出三个零，而不是报错', async () => {
    const org = await newOrg('empty');

    const result = await report(org);
    expect(result.outputTax).toEqual({ netMinor: 0n, taxMinor: 0n, unmatchedTaxMinor: 0n });
    expect(result.inputTax).toEqual({ netMinor: 0n, taxMinor: 0n, unmatchedTaxMinor: 0n });
    expect(result.netPayableMinor).toBe(0n);
  });
});

describe('getTaxReport - 外币按本位币口径', () => {
  // invoices / bills 上既没有 exchange_rate 也没有 base_amount_minor，
  // 从单据聚合就必须自己再写一遍换算。journal_lines.base_amount_minor 是
  // 记账边界当时就算好的，直接用它，全项目只有一份换算实现。
  it('USD 发票按开票日汇率折成本位币计入，不与 MYR 混加', async () => {
    const org = await newOrg('fx');
    await seedRate('USD', 'MYR', 435000000n, ON);

    await postInvoice(org, { net: 10000n, tax: 600n }); // MYR 100.00 + 6.00
    await postInvoice(org, {
      net: 10000n,
      tax: 600n,
      currency: 'USD',
      manualRate: '4.35',
    }); // USD 100.00 + 6.00 -> MYR 435.00 + 26.10

    const result = await report(org);
    // 旧写法把两张单的 tax_minor 直接相加得 1200——一个既不是马币也不是
    // 美元的数。这里是 600 + 2610。
    expect(result.outputTax.taxMinor).toBe(3210n);
    expect(result.outputTax.netMinor).toBe(53500n);
  });
});

describe('getTaxReportAction - 日期必须是日期', () => {
  it('拒绝非日期字符串与颠倒的区间，并带回本位币', async () => {
    const org = await newOrg('action');

    currentUserId = ownerId;
    await expect(getTaxReportAction(org.slug, 'yesterday', TO)).rejects.toThrow();
    await expect(getTaxReportAction(org.slug, TO, FROM)).rejects.toThrow(/on or before/i);

    const result = await getTaxReportAction(org.slug, FROM, TO);
    // 报表里每一个数都是本位币最小单位，调用方从返回值里看得出那是哪种钱。
    expect(result.baseCurrency).toBe('MYR');
    expect(result.netPayableMinor).toBe(0n);
  });
});
