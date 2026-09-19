import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import type { OrgContext } from '@/server/auth/guard';
import { postJournal } from '@/server/posting/post-journal';
import { creditNoteAmountsMinor } from '@/server/repositories/credit_notes';
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

const {
  createCreditNote,
  issueCreditNote,
  applyCreditNote,
  updateCreditNoteAction,
  voidCreditNote,
} = await import('@/server/actions/credit_notes');

/**
 * 迁移 0021 给 credit_notes 加 transaction_id，没有它这张单据即便过账了也
 * 找不回自己的那笔交易——本文件里凡是碰过账的用例都依赖那一列。
 *
 * 用运行时探测而不是无条件跑：目标库现在还没执行 0021，无条件跑的结果是
 * 一整屏 `column cn.transaction_id does not exist`，把「代码写错了」与
 * 「迁移还没跑」混成同一种红色。跳过时报告里会写明它们待迁移执行，迁移
 * 一落地这些用例就自动开始跑，不需要再改这个文件。
 */
const migrated =
  (
    await admin`
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'credit_notes'
        and column_name = 'transaction_id'
    `
  ).length > 0;

const describeIfMigrated = migrated ? describe : describe.skip;

let ownerId: string;
let org: SeededOrg;
let ctx: OrgContext;
let customerId: string;
let sstRateId: string;

const suffix = randomUUID().slice(0, 8);
const DAY = '2026-09-24';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-cn-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;

  org = await createTestOrgWithSeed(ownerId, 'Credit Note Co', `cn-co-${suffix}`, 'MYR');
  ctx = {
    userId: ownerId,
    organizationId: org.id,
    orgSlug: org.slug,
    role: 'owner',
    baseCurrency: 'MYR',
    lockedUntil: null,
    timezone: 'Asia/Kuala_Lumpur',
  };

  const [contact] = await admin`
    insert into contacts (organization_id, type, name)
    values (${org.id}, 'customer', 'CN Customer')
    returning id
  `;
  customerId = contact.id as string;

  const [rate] = await admin`
    insert into tax_rates (organization_id, name_en, name_zh, rate_bps)
    values (${org.id}, 'SST 6%', '销售税 6%', 600)
    returning id
  `;
  sstRateId = rate.id as string;
});

afterAll(async () => {
  // credit_notes.invoice_id 指向 invoices 却没有 on delete cascade（0020 只
  // 补了指向 transactions 的那一批），删公司时两条级联的触发器顺序会把整句
  // delete 顶回来。先把贷项通知单删掉。
  await admin`delete from credit_notes where organization_id = ${org.id}`;
  await resetTestData();
  await admin.end();
});

async function createPostedInvoice(args: {
  number: string;
  currency: string;
  totalMinor: bigint;
  rate: string;
}): Promise<string> {
  const [invoice] = await admin`
    insert into invoices (
      organization_id, contact_id, invoice_number, status,
      issue_date, due_date, currency, subtotal_minor, tax_rate_bps,
      tax_minor, total_minor
    )
    values (
      ${org.id}, ${customerId}, ${args.number}, 'sent',
      ${DAY}, ${DAY}, ${args.currency}, ${args.totalMinor.toString()}, 0,
      0, ${args.totalMinor.toString()}
    )
    returning id
  `;

  const posted = await withTransaction(ownerId, (tx) =>
    postJournal(tx, ctx, {
      event: {
        type: 'invoice',
        receivableAccountId: org.accountsByCode['accounts-receivable'],
        revenueAccountId: org.accountsByCode.sales,
        taxAccountId: null,
        netMinor: args.totalMinor,
        taxMinor: 0n,
        amountMinor: args.totalMinor,
      },
      occurredOn: DAY,
      description: `Invoice ${args.number}`,
      currency: args.currency,
      manualRate: args.rate,
      manualRateEntry: 'available',
      categoryId: null,
      clientUuid: randomUUID(),
    }),
  );

  await admin`update invoices set transaction_id = ${posted.transactionId} where id = ${invoice.id}`;
  return invoice.id as string;
}

async function creditNoteRow(id: string) {
  const [row] = await admin`
    select status, currency, exchange_rate, base_amount_minor, transaction_id
    from credit_notes where id = ${id}
  `;
  return row;
}

async function linesFor(transactionId: string) {
  return admin`
    select a.code, l.direction, l.amount_minor, l.base_amount_minor
    from journal_lines l join accounts a on a.id = l.account_id
    where l.transaction_id = ${transactionId}
    order by l.direction, a.code
  `;
}

async function invoiceStatus(id: string): Promise<string> {
  const [row] = await admin`select status from invoices where id = ${id}`;
  return row.status as string;
}

describe('creditNoteAmountsMinor — 按行算税，整数 half-up', () => {
  it('免税行不被算上税', () => {
    expect(
      creditNoteAmountsMinor([
        { amountMinor: 10_000n, taxRateBps: 600 },
        { amountMinor: 10_000n, taxRateBps: 0 },
      ]),
    ).toEqual({ netMinor: 20_000n, taxMinor: 600n, totalMinor: 20_600n });
  });

  it('半分进位向上，而不是像 invoices.ts 那样截断', () => {
    // 125 分 @ 6% = 7.5 分。half-up 得 8；截断（invoices.ts 现在的写法）得 7。
    expect(creditNoteAmountsMinor([{ amountMinor: 125n, taxRateBps: 600 }])).toEqual({
      netMinor: 125n,
      taxMinor: 8n,
      totalMinor: 133n,
    });
    expect((125n * 600n) / 10_000n).toBe(7n);
  });

  it('多行混合税率时逐行算，不拿整单套一个税率', () => {
    expect(
      creditNoteAmountsMinor([
        { amountMinor: 333n, taxRateBps: 600 },
        { amountMinor: 333n, taxRateBps: 1000 },
      ]),
    ).toEqual({ netMinor: 666n, taxMinor: 20n + 33n, totalMinor: 666n + 53n });
  });
});

describeIfMigrated('createCreditNote', () => {
  it('外币贷项通知单的 base_amount_minor 真的被换算过（B2）', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'USD',
      exchangeRate: '4.20',
      items: [{ description: 'Returned goods', quantity: '2', unitPrice: '100.00' }],
    });

    const row = await creditNoteRow(id);
    expect(row.currency.trim()).toBe('USD');
    // 200.00 USD @ 4.20 = 840.00 MYR。改动前这里写的是 20000（原币直接当本位币）。
    expect(row.base_amount_minor).toBe('84000');
    // B7：放大 10^8 的定标整数，不是 "4.20" 也不是 4。
    expect(row.exchange_rate).toBe('420000000');
    expect(row.status).toBe('draft');
  });

  it('税额进 base_amount_minor —— 贷项通知单冲的是含税总额（B4）', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'MYR',
      items: [
        { description: 'Taxed line', quantity: '1', unitPrice: '100.00', taxRateId: sstRateId },
      ],
    });

    // 10,000 分净额 + 600 分税 = 10,600 分。
    expect((await creditNoteRow(id)).base_amount_minor).toBe('10600');
  });

  it('写一条 credit_note.created 审计，且 after 是 jsonb 对象（B5）', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'MYR',
      items: [{ description: 'Audit line', quantity: '1', unitPrice: '30.00' }],
    });

    const rows = await admin`
      select after, jsonb_typeof(after) as kind
      from audit_logs
      where organization_id = ${org.id}
        and action = 'credit_note.created' and entity_id = ${id}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('object');
    expect((rows[0].after as Record<string, unknown>).totalMinor).toBe('3000');
  });

  it('拒绝用别家公司的税率', async () => {
    const otherOwner = await createTestUser(`test-other-cn-${suffix}@example.com`, 'Other');
    const otherOrg = await createTestOrgWithSeed(
      otherOwner,
      'Other Co',
      `other-cn-${suffix}`,
      'MYR',
    );
    const [foreignRate] = await admin`
      insert into tax_rates (organization_id, name_en, name_zh, rate_bps)
      values (${otherOrg.id}, 'VAT', '增值税', 1000)
      returning id
    `;

    await expect(
      createCreditNote(org.slug, {
        contactId: customerId,
        issueDate: DAY,
        currency: 'MYR',
        items: [
          {
            description: 'Sneaky',
            quantity: '1',
            unitPrice: '10.00',
            taxRateId: foreignRate.id as string,
          },
        ],
      }),
    ).rejects.toThrow(/tax rates/i);
  });
});

describeIfMigrated('issueCreditNote — 进总账', () => {
  it('过账「借收入 / 借销项税 / 贷应收」，并回写 transaction_id', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'MYR',
      items: [
        { description: 'Returned', quantity: '1', unitPrice: '100.00', taxRateId: sstRateId },
      ],
    });

    await issueCreditNote(org.slug, id);

    const row = await creditNoteRow(id);
    expect(row.status).toBe('issued');
    expect(row.transaction_id).not.toBeNull();

    expect(await linesFor(row.transaction_id as string)).toEqual([
      { code: 'sales', direction: 'debit', amount_minor: '10000', base_amount_minor: '10000' },
      { code: 'tax-payable', direction: 'debit', amount_minor: '600', base_amount_minor: '600' },
      {
        code: 'accounts-receivable',
        direction: 'credit',
        amount_minor: '10600',
        base_amount_minor: '10600',
      },
    ]);
  });

  it('外币贷项通知单按单据自己记下的汇率过账，分录与单据对得上', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'USD',
      exchangeRate: '4.20',
      items: [{ description: 'FX return', quantity: '1', unitPrice: '100.00' }],
    });

    await issueCreditNote(org.slug, id);

    const row = await creditNoteRow(id);
    expect(await linesFor(row.transaction_id as string)).toEqual([
      { code: 'sales', direction: 'debit', amount_minor: '10000', base_amount_minor: '42000' },
      {
        code: 'accounts-receivable',
        direction: 'credit',
        amount_minor: '10000',
        base_amount_minor: '42000',
      },
    ]);
    // 单据上的本位币金额与分录上的一致——这正是过账时沿用单据汇率的理由。
    expect(row.base_amount_minor).toBe('42000');
  });

  it('重复签发是幂等的，不会记出第二笔应收冲减', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'MYR',
      items: [{ description: 'Twice', quantity: '1', unitPrice: '25.00' }],
    });

    await issueCreditNote(org.slug, id);
    const first = await creditNoteRow(id);
    await issueCreditNote(org.slug, id);
    const second = await creditNoteRow(id);

    expect(second.transaction_id).toBe(first.transaction_id);
  });

  it('签发之后挂着的发票状态跟着重算', async () => {
    const invoiceId = await createPostedInvoice({
      number: `INV-CN-${suffix}`,
      currency: 'MYR',
      totalMinor: 10_000n,
      rate: '1',
    });

    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      invoiceId,
      issueDate: DAY,
      currency: 'MYR',
      items: [{ description: 'Full credit', quantity: '1', unitPrice: '100.00' }],
    });

    expect(await invoiceStatus(invoiceId)).toBe('sent');
    await issueCreditNote(org.slug, id);
    expect(await invoiceStatus(invoiceId)).toBe('paid');
  });
});

describeIfMigrated('生命周期守卫', () => {
  it('已签发的贷项通知单不能再改', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'MYR',
      items: [{ description: 'Locked', quantity: '1', unitPrice: '10.00' }],
    });

    await issueCreditNote(org.slug, id);

    await expect(
      updateCreditNoteAction(org.slug, id, { notes: 'late edit' }),
    ).rejects.toThrow(/already been issued/);
  });

  it('草稿不能直接标记为已抵扣——那会让一张从未进账的单据出现在对账单上', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'MYR',
      items: [{ description: 'Draft', quantity: '1', unitPrice: '10.00' }],
    });

    await expect(applyCreditNote(org.slug, id)).rejects.toThrow(/must be issued/);

    await issueCreditNote(org.slug, id);
    await applyCreditNote(org.slug, id);
    expect((await creditNoteRow(id)).status).toBe('applied');
  });

  it('改草稿时不传币种，用的是这张单据自己的币种而不是本位币', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'USD',
      exchangeRate: '4.20',
      items: [{ description: 'Before', quantity: '1', unitPrice: '10.00' }],
    });

    await updateCreditNoteAction(org.slug, id, {
      exchangeRate: '4.50',
      items: [{ description: 'After', quantity: '1', unitPrice: '10.00' }],
    });

    const row = await creditNoteRow(id);
    expect(row.currency.trim()).toBe('USD');
    // 10.00 USD @ 4.50 = 45.00 MYR。若误用本位币的小数位/汇率，这里会是 1000。
    expect(row.base_amount_minor).toBe('4500');
  });

  it('换币种却不重报明细时直接拒绝', async () => {
    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      issueDate: DAY,
      currency: 'USD',
      exchangeRate: '4.20',
      items: [{ description: 'Ccy', quantity: '1', unitPrice: '10.00' }],
    });

    await expect(
      updateCreditNoteAction(org.slug, id, { currency: 'JPY' }),
    ).rejects.toThrow(/re-entering its line amounts/);
  });
});

describeIfMigrated('voidCreditNote', () => {
  it('连带作废分录，并把发票状态退回去', async () => {
    const invoiceId = await createPostedInvoice({
      number: `INV-CNVOID-${suffix}`,
      currency: 'MYR',
      totalMinor: 10_000n,
      rate: '1',
    });

    const { id } = await createCreditNote(org.slug, {
      contactId: customerId,
      invoiceId,
      issueDate: DAY,
      currency: 'MYR',
      items: [{ description: 'To be voided', quantity: '1', unitPrice: '100.00' }],
    });

    await issueCreditNote(org.slug, id);
    expect(await invoiceStatus(invoiceId)).toBe('paid');

    const before = await creditNoteRow(id);
    await voidCreditNote(org.slug, id);

    const after = await creditNoteRow(id);
    expect(after.status).toBe('voided');

    const [txn] = await admin`
      select voided_at from transactions where id = ${before.transaction_id as string}
    `;
    expect(txn.voided_at).not.toBeNull();

    expect(await invoiceStatus(invoiceId)).toBe('sent');
  });
});
