import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import type { OrgContext } from '@/server/auth/guard';
import { postJournal } from '@/server/posting/post-journal';
import {
  createTestOrgWithSeed,
  createTestUser,
  resetTestData,
  type SeededOrg,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createPayment, voidPaymentAction } = await import('@/server/actions/payments');

let ownerId: string;
/** 大部分用例共用这一家公司。 */
let org: SeededOrg;
let ctx: OrgContext;
let customerId: string;
/** 「分三次收完、应收精确归零」那一条独占一家公司，见它自己的注释。 */
let zeroOrg: SeededOrg;
let zeroCtx: OrgContext;
let zeroCustomerId: string;

const suffix = randomUUID().slice(0, 8);

// 汇率一律由入参手工给出，不碰 exchange_rates ——那张表没有公司维度，
// 并行跑的其他测试文件会往同一个 (base, quote, date) 上写自己的值。
const DAY = '2026-09-21';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-pay-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;

  org = await createTestOrgWithSeed(ownerId, 'Payments Co', `payments-co-${suffix}`, 'MYR');
  ctx = orgContext(org);
  customerId = await createContact(org.id, 'Acme Sdn Bhd');

  zeroOrg = await createTestOrgWithSeed(ownerId, 'Zero Co', `zero-co-${suffix}`, 'MYR');
  zeroCtx = orgContext(zeroOrg);
  zeroCustomerId = await createContact(zeroOrg.id, 'Zero Customer');
});

afterAll(async () => {
  // payment_items.invoice_id / bill_id 指向 invoices / bills 却没有
  // on delete cascade（0020 只补了指向 transactions 的那一批）。删公司时
  // invoices 的级联删除与 payment_items 的引用完整性检查同在一条 delete 的
  // 触发器队列里，检查排在前面就把整句顶回来——与 0020 注释里描述的
  // depreciation_schedules 是同一个形状。先把收付款删掉（payment_items
  // 由 payment_id 那条 cascade 带走），组织删除才做得下去。
  await admin`delete from payments where organization_id = any(${[org.id, zeroOrg.id]})`;
  await resetTestData();
  await admin.end();
});

function orgContext(seeded: SeededOrg): OrgContext {
  return {
    userId: ownerId,
    organizationId: seeded.id,
    orgSlug: seeded.slug,
    role: 'owner',
    baseCurrency: 'MYR',
    lockedUntil: null,
    timezone: 'Asia/Kuala_Lumpur',
  };
}

async function createContact(organizationId: string, name: string): Promise<string> {
  const [row] = await admin`
    insert into contacts (organization_id, type, name)
    values (${organizationId}, 'customer', ${name})
    returning id
  `;
  return row.id as string;
}

/**
 * 建一张发票并把它过账——汇兑损益的 R1 只能来自这一笔交易。
 *
 * 这里不调用 server/actions/invoices.ts：那个文件属于另一条并行的改动，
 * 它有没有过账、怎么过账都与本文件要测的东西无关。自己用 postJournal 造
 * 一笔「借应收 / 贷收入」，R1 就完全在这个测试的掌握之中。
 */
async function createPostedInvoice(args: {
  seeded: SeededOrg;
  context: OrgContext;
  contactId: string;
  number: string;
  currency: string;
  totalMinor: bigint;
  /** 开票日汇率 R1。本位币发票传 '1'。 */
  rate: string;
  issueDate?: string;
}): Promise<{ id: string; transactionId: string }> {
  const issueDate = args.issueDate ?? DAY;

  const [invoice] = await admin`
    insert into invoices (
      organization_id, contact_id, invoice_number, status,
      issue_date, due_date, currency, subtotal_minor, tax_rate_bps,
      tax_minor, total_minor
    )
    values (
      ${args.seeded.id}, ${args.contactId}, ${args.number}, 'sent',
      ${issueDate}, ${issueDate}, ${args.currency}, ${args.totalMinor.toString()}, 0,
      0, ${args.totalMinor.toString()}
    )
    returning id
  `;

  const posted = await withTransaction(ownerId, (tx) =>
    postJournal(tx, args.context, {
      event: {
        type: 'invoice',
        receivableAccountId: args.seeded.accountsByCode['accounts-receivable'],
        revenueAccountId: args.seeded.accountsByCode.sales,
        taxAccountId: null,
        netMinor: args.totalMinor,
        taxMinor: 0n,
        amountMinor: args.totalMinor,
      },
      occurredOn: issueDate,
      description: `Invoice ${args.number}`,
      currency: args.currency,
      manualRate: args.rate,
      manualRateEntry: 'available',
      categoryId: null,
      clientUuid: randomUUID(),
    }),
  );

  await admin`
    update invoices set transaction_id = ${posted.transactionId}
    where id = ${invoice.id}
  `;

  return { id: invoice.id as string, transactionId: posted.transactionId };
}

async function linesFor(transactionId: string) {
  return admin`
    select a.code, l.direction, l.amount_minor, l.base_amount_minor
    from journal_lines l join accounts a on a.id = l.account_id
    where l.transaction_id = ${transactionId}
    order by l.direction, a.code
  `;
}

async function paymentRow(id: string) {
  const [row] = await admin`
    select transaction_id, amount_minor, base_amount_minor, exchange_rate, voided_at
    from payments where id = ${id}
  `;
  return row;
}

async function invoiceStatus(id: string): Promise<string> {
  const [row] = await admin`select status from invoices where id = ${id}`;
  return row.status as string;
}

/** 这一家公司里应收账款的净余额（借 - 贷），已作废的交易不计。 */
async function receivableBalance(seeded: SeededOrg): Promise<bigint> {
  const [row] = await admin`
    select coalesce(sum(
      case when l.direction = 'debit' then l.base_amount_minor else -l.base_amount_minor end
    ), 0) as balance
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    where l.account_id = ${seeded.accountsByCode['accounts-receivable']}
      and t.voided_at is null
  `;
  return BigInt(row.balance as string);
}

/** 这笔收付款产生的全部交易（收款本身 + 汇兑调整），按摘要排序。 */
async function transactionsFor(organizationId: string, sourceId: string) {
  return admin`
    select t.id, t.description, t.currency, t.exchange_rate, t.base_amount_minor, t.voided_at
    from transactions t
    join audit_logs a
      on a.entity_id = t.id and a.action = 'transaction.created'
    where t.organization_id = ${organizationId}
      and a.after->>'sourceId' = ${sourceId}
    order by t.description
  `;
}

describe('createPayment — 本位币收款', () => {
  it('过账「借银行 / 贷应收」，回写 transaction_id，并把发票标记为已付', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-MYR-${suffix}`,
      currency: 'MYR',
      totalMinor: 120_000n,
      rate: '1',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '1200.00',
      currency: 'MYR',
      paymentDate: DAY,
      method: 'bank_transfer',
      reference: 'WIRE-1',
      items: [{ invoiceId: invoice.id, amount: '1200.00' }],
    });

    const payment = await paymentRow(id);
    expect(payment.transaction_id).not.toBeNull();
    expect(payment.base_amount_minor).toBe('120000');
    expect(payment.exchange_rate).toBe('100000000');

    expect(await linesFor(payment.transaction_id as string)).toEqual([
      { code: 'bank', direction: 'debit', amount_minor: '120000', base_amount_minor: '120000' },
      {
        code: 'accounts-receivable',
        direction: 'credit',
        amount_minor: '120000',
        base_amount_minor: '120000',
      },
    ]);

    expect(await invoiceStatus(invoice.id)).toBe('paid');

    // 同币种没有汇兑差额，所以只有收款那一笔交易。
    expect((await transactionsFor(org.id, id)).length).toBe(1);
  });

  it('部分收款把发票标记为 partially_paid', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-PART-${suffix}`,
      currency: 'MYR',
      totalMinor: 100_000n,
      rate: '1',
    });

    await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '400.00',
      currency: 'MYR',
      paymentDate: DAY,
      method: 'cash',
      items: [{ invoiceId: invoice.id, amount: '400.00' }],
    });

    expect(await invoiceStatus(invoice.id)).toBe('partially_paid');
  });

  it('现金收款记到 cash 科目，其余方式记到 bank', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-CASH-${suffix}`,
      currency: 'MYR',
      totalMinor: 5_000n,
      rate: '1',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '50.00',
      currency: 'MYR',
      paymentDate: DAY,
      method: 'cash',
      items: [{ invoiceId: invoice.id, amount: '50.00' }],
    });

    const payment = await paymentRow(id);
    const lines = await linesFor(payment.transaction_id as string);
    expect(lines[0].code).toBe('cash');
  });

  /**
   * payment_items 上的 payment_items_one_target 要求发票与账单恰好一非空。
   * 而收付款表单在用户一张单据都没勾时送的正是两个都为 null——那条路径今天
   * 必然失败，问题只在于用户读到的是一句人话还是一条 Postgres 约束报错。
   */
  it('两个目标都不填时给出一句读得懂的话，而不是裸的 CHECK 约束报错', async () => {
    await expect(
      createPayment(org.slug, {
        contactId: customerId,
        type: 'received',
        amount: '50.00',
        currency: 'MYR',
        paymentDate: DAY,
        method: 'cash',
        items: [{ invoiceId: null, billId: null, amount: '50.00' }],
      }),
    ).rejects.toThrow(/Choose which invoice/);
  });

  it('客户端传进来的 transactionId 被完全忽略——那个字段已经不在入参里', async () => {
    // 造一笔与本次收款毫无关系的交易，模拟「客户端指定一个 transaction_id」。
    const foreign = await withTransaction(ownerId, (tx) =>
      postJournal(tx, ctx, {
        event: {
          type: 'journal',
          debitAccountId: org.accountsByCode.cash,
          creditAccountId: org.accountsByCode.suspense,
          amountMinor: 100n,
        },
        occurredOn: DAY,
        description: 'unrelated',
        currency: 'MYR',
        manualRateEntry: 'available',
        categoryId: null,
        clientUuid: randomUUID(),
      }),
    );

    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-IGNORE-${suffix}`,
      currency: 'MYR',
      totalMinor: 1_000n,
      rate: '1',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '10.00',
      currency: 'MYR',
      paymentDate: DAY,
      method: 'bank_transfer',
      items: [{ invoiceId: invoice.id, amount: '10.00' }],
      // zod 的 object 默认剥掉未声明的键，这一行连解析都进不来 —— 正是要的效果。
      transactionId: foreign.transactionId,
    } as never);

    const payment = await paymentRow(id);
    expect(payment.transaction_id).not.toBe(foreign.transactionId);
  });
});

describe('createPayment — 外币收款与汇兑损益', () => {
  it('升值：开票 4.20、收款 4.50，另起一笔「借应收 / 贷 fx-gain」', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-GAIN-${suffix}`,
      currency: 'USD',
      totalMinor: 100_000n, // 1,000.00 USD -> 420,000 sen
      rate: '4.20',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '1000.00',
      currency: 'USD',
      exchangeRate: '4.50',
      paymentDate: DAY,
      method: 'bank_transfer',
      items: [{ invoiceId: invoice.id, amount: '1000.00' }],
    });

    const payment = await paymentRow(id);
    expect(payment.base_amount_minor).toBe('450000');
    expect(payment.exchange_rate).toBe('450000000');

    // 收款那一笔：整笔按 R2，两行都是 450,000——内部只有一个汇率，过得了 I3。
    expect(await linesFor(payment.transaction_id as string)).toEqual([
      { code: 'bank', direction: 'debit', amount_minor: '100000', base_amount_minor: '450000' },
      {
        code: 'accounts-receivable',
        direction: 'credit',
        amount_minor: '100000',
        base_amount_minor: '450000',
      },
    ]);

    const all = await transactionsFor(org.id, id);
    expect(all.length).toBe(2);

    const adjustment = all.find((t) => String(t.description).includes('exchange gain'));
    expect(adjustment).toBeDefined();
    // 纯本位币凭证，汇率恰好为 1，不触发 I4。
    expect(adjustment?.currency.trim()).toBe('MYR');
    expect(Number(adjustment?.exchange_rate)).toBe(1);

    expect(await linesFor(adjustment?.id as string)).toEqual([
      {
        code: 'accounts-receivable',
        direction: 'debit',
        amount_minor: '30000',
        base_amount_minor: '30000',
      },
      { code: 'fx-gain', direction: 'credit', amount_minor: '30000', base_amount_minor: '30000' },
    ]);
  });

  it('贬值：开票 4.20、收款 4.00，另起一笔「借 fx-loss / 贷应收」', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-LOSS-${suffix}`,
      currency: 'USD',
      totalMinor: 100_000n,
      rate: '4.20',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '1000.00',
      currency: 'USD',
      exchangeRate: '4.00',
      paymentDate: DAY,
      method: 'bank_transfer',
      items: [{ invoiceId: invoice.id, amount: '1000.00' }],
    });

    const all = await transactionsFor(org.id, id);
    const adjustment = all.find((t) => String(t.description).includes('exchange loss'));
    expect(adjustment).toBeDefined();

    expect(await linesFor(adjustment?.id as string)).toEqual([
      { code: 'fx-loss', direction: 'debit', amount_minor: '20000', base_amount_minor: '20000' },
      {
        code: 'accounts-receivable',
        direction: 'credit',
        amount_minor: '20000',
        base_amount_minor: '20000',
      },
    ]);
  });

  it('零小数币种（JPY）：本位币金额不能少一个数量级', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-JPY-${suffix}`,
      currency: 'JPY',
      totalMinor: 100_000n, // 100,000 日元 @ 0.031 -> 3,100.00 MYR
      rate: '0.031',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '100000',
      currency: 'JPY',
      exchangeRate: '0.030',
      paymentDate: DAY,
      method: 'bank_transfer',
      items: [{ invoiceId: invoice.id, amount: '100000' }],
    });

    const payment = await paymentRow(id);
    // B1 那份手抄实现会给出 3100（= 31.00 令吉），差整整 100 倍。
    expect(payment.base_amount_minor).toBe('300000');

    const all = await transactionsFor(org.id, id);
    const adjustment = all.find((t) => String(t.description).includes('exchange loss'));
    expect(await linesFor(adjustment?.id as string)).toEqual([
      { code: 'fx-loss', direction: 'debit', amount_minor: '10000', base_amount_minor: '10000' },
      {
        code: 'accounts-receivable',
        direction: 'credit',
        amount_minor: '10000',
        base_amount_minor: '10000',
      },
    ]);
  });

  /**
   * 本文件最重要的一条。
   *
   * 独占一家公司，是因为断言的是「这家公司的应收账款净余额恰好为 0」——
   * 与其他用例共用一家公司的话，那些用例留下的部分收款会把余额搅浑，而这
   * 一条要量的正是「一分钱都不许剩」。
   */
  it('一张外币发票分三次不等额收完之后，应收余额精确为 0', async () => {
    const invoice = await createPostedInvoice({
      seeded: zeroOrg,
      context: zeroCtx,
      contactId: zeroCustomerId,
      number: `INV-THREE-${suffix}`,
      currency: 'USD',
      totalMinor: 100_000n,
      rate: '4.2345', // 4,234.50 MYR，一个会逼出舍入的汇率
    });

    // 开票之后应收上挂着 4,234.50。
    expect(await receivableBalance(zeroOrg)).toBe(423_450n);

    const receipts = [
      { amount: '333.33', rate: '4.31' },
      { amount: '333.33', rate: '4.18' },
      { amount: '333.34', rate: '4.2345' },
    ];

    for (const [index, receipt] of receipts.entries()) {
      await createPayment(zeroOrg.slug, {
        contactId: zeroCustomerId,
        type: 'received',
        amount: receipt.amount,
        currency: 'USD',
        exchangeRate: receipt.rate,
        paymentDate: DAY,
        method: 'bank_transfer',
        reference: `PART-${index + 1}`,
        items: [{ invoiceId: invoice.id, amount: receipt.amount }],
      });
    }

    expect(await receivableBalance(zeroOrg)).toBe(0n);
    expect(await invoiceStatus(invoice.id)).toBe('paid');
  });
});

describe('createPayment — 校验', () => {
  it('拒绝核销别家公司的发票', async () => {
    const foreignInvoice = await createPostedInvoice({
      seeded: zeroOrg,
      context: zeroCtx,
      contactId: zeroCustomerId,
      number: `INV-FOREIGN-${suffix}`,
      currency: 'MYR',
      totalMinor: 10_000n,
      rate: '1',
    });

    await expect(
      createPayment(org.slug, {
        contactId: customerId,
        type: 'received',
        amount: '100.00',
        currency: 'MYR',
        paymentDate: DAY,
        method: 'bank_transfer',
        items: [{ invoiceId: foreignInvoice.id, amount: '100.00' }],
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('拒绝用与单据不同的币种去核销它', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-CCY-${suffix}`,
      currency: 'USD',
      totalMinor: 10_000n,
      rate: '4.20',
    });

    await expect(
      createPayment(org.slug, {
        contactId: customerId,
        type: 'received',
        amount: '100.00',
        currency: 'MYR',
        paymentDate: DAY,
        method: 'bank_transfer',
        items: [{ invoiceId: invoice.id, amount: '100.00' }],
      }),
    ).rejects.toThrow(/USD/);
  });

  it('收款不能核销账单，付款不能核销发票', async () => {
    await expect(
      createPayment(org.slug, {
        contactId: customerId,
        type: 'received',
        amount: '100.00',
        currency: 'MYR',
        paymentDate: DAY,
        method: 'bank_transfer',
        items: [{ billId: randomUUID(), amount: '100.00' }],
      }),
    ).rejects.toThrow(/invoices, not bills/);
  });

  it('核销金额合计不能超过这笔钱本身', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-OVER-${suffix}`,
      currency: 'MYR',
      totalMinor: 100_000n,
      rate: '1',
    });

    await expect(
      createPayment(org.slug, {
        contactId: customerId,
        type: 'received',
        amount: '100.00',
        currency: 'MYR',
        paymentDate: DAY,
        method: 'bank_transfer',
        items: [{ invoiceId: invoice.id, amount: '200.00' }],
      }),
    ).rejects.toThrow(/add up to more than this payment/);
  });
});

describe('审计与作废', () => {
  it('createPayment 写一条 payment.created 审计，且 after 是 jsonb 对象而不是字符串', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-AUDIT-${suffix}`,
      currency: 'MYR',
      totalMinor: 7_700n,
      rate: '1',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '77.00',
      currency: 'MYR',
      paymentDate: DAY,
      method: 'bank_transfer',
      items: [{ invoiceId: invoice.id, amount: '77.00' }],
    });

    const rows = await admin`
      select after, jsonb_typeof(after) as kind
      from audit_logs
      where organization_id = ${org.id} and action = 'payment.created' and entity_id = ${id}
    `;

    expect(rows.length).toBe(1);
    // recordAudit 注释里那个坑：先 JSON.stringify 再传会存成 jsonb 标量字符串。
    expect(rows[0].kind).toBe('object');
    expect((rows[0].after as Record<string, unknown>).amountMinor).toBe('7700');
  });

  it('作废收款时连带作废收款分录与汇兑调整，并把发票状态退回去', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-VOID-${suffix}`,
      currency: 'USD',
      totalMinor: 100_000n,
      rate: '4.20',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '1000.00',
      currency: 'USD',
      exchangeRate: '4.50',
      paymentDate: DAY,
      method: 'bank_transfer',
      items: [{ invoiceId: invoice.id, amount: '1000.00' }],
    });

    expect(await invoiceStatus(invoice.id)).toBe('paid');
    expect((await transactionsFor(org.id, id)).length).toBe(2);

    await voidPaymentAction(org.slug, id);

    const payment = await paymentRow(id);
    expect(payment.voided_at).not.toBeNull();

    const all = await transactionsFor(org.id, id);
    expect(all.length).toBe(2);
    // 两笔都作废了——汇兑调整没有任何一列指得回来，靠的是确定性 client_uuid。
    expect(all.every((t) => t.voided_at !== null)).toBe(true);

    expect(await invoiceStatus(invoice.id)).toBe('sent');
  });

  it('重复作废是幂等的', async () => {
    const invoice = await createPostedInvoice({
      seeded: org,
      context: ctx,
      contactId: customerId,
      number: `INV-IDEM-${suffix}`,
      currency: 'MYR',
      totalMinor: 1_200n,
      rate: '1',
    });

    const { id } = await createPayment(org.slug, {
      contactId: customerId,
      type: 'received',
      amount: '12.00',
      currency: 'MYR',
      paymentDate: DAY,
      method: 'bank_transfer',
      items: [{ invoiceId: invoice.id, amount: '12.00' }],
    });

    await voidPaymentAction(org.slug, id);
    await expect(voidPaymentAction(org.slug, id)).resolves.toBeUndefined();
  });
});
