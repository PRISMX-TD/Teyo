/**
 * 客户 / 供应商对账单。
 *
 * 这两个函数在重写之前**跑不起来**：期初余额那条 SQL 写的是
 * `select coalesce(sum(i.total_minor), 0) ...`，而整条语句里没有
 * `from invoices i`，Postgres 直接报 "missing FROM-clause entry for table i"。
 * 全项目当时没有任何地方调用它们，所以一直没暴露。
 *
 * 除此之外还有与账龄表同一批的口径问题：把 credit_notes.base_amount_minor
 * （其实装的是原币总额）当本位币用、把 payment_items.amount_minor 原样当
 * 本位币用。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';
import { getCustomerStatement, getVendorStatement } from '@/server/repositories/aging';

const suffix = randomUUID().slice(0, 8);

/**
 * 迁移 0021 给 credit_notes 补了 transaction_id（用来拿到贷项通知单的本位币
 * 金额）。生产库尚未执行这条迁移，而 getCustomerStatement 已经按 0021 之后
 * 的形态写。这里在收集用例之前先探一次列是否存在：缺列时整个客户对账单的
 * describe 跳过并在标题上写明原因，而不是留一条红色的失败让人以为逻辑写错。
 * 供应商对账单不碰 credit_notes，任何时候都跑。
 */
const [cnColumn] = await admin`
  select 1 as present
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'credit_notes'
    and column_name = 'transaction_id'
`;
const creditNoteTransactionIdExists = Boolean(cnColumn);

let ownerId: string;
let orgId: string;
let customerId: string;
let vendorId: string;

let seq = 0;

async function insertInvoice(args: {
  totalMinor: bigint;
  issueDate: string;
  currency?: string;
  status?: string;
}): Promise<string> {
  seq += 1;
  const [row] = await admin`
    insert into invoices
      (organization_id, contact_id, invoice_number, status, issue_date, due_date,
       currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor)
    values (${orgId}, ${customerId}, ${`ST-INV-${suffix}-${seq}`}, ${args.status ?? 'sent'},
       ${args.issueDate}::date, ${args.issueDate}::date, ${args.currency ?? 'MYR'},
       ${args.totalMinor.toString()}, 0, 0, ${args.totalMinor.toString()})
    returning id
  `;
  return row.id as string;
}

async function insertBill(args: { totalMinor: bigint; issueDate: string }): Promise<string> {
  seq += 1;
  const [row] = await admin`
    insert into bills
      (organization_id, contact_id, bill_number, status, issue_date, due_date, currency,
       total_minor, subtotal_minor)
    values (${orgId}, ${vendorId}, ${`ST-BILL-${suffix}-${seq}`}, 'received',
       ${args.issueDate}::date, ${args.issueDate}::date, 'MYR',
       ${args.totalMinor.toString()}, ${args.totalMinor.toString()})
    returning id
  `;
  return row.id as string;
}

async function insertPayment(args: {
  type: 'received' | 'made';
  currency: string;
  amountMinor: bigint;
  baseAmountMinor: bigint;
  paymentDate: string;
  reference: string;
  invoiceId?: string;
  billId?: string;
  allocatedMinor: bigint;
}): Promise<void> {
  const scaledRate = (args.baseAmountMinor * 100_000_000n) / args.amountMinor;
  const [payment] = await admin`
    insert into payments
      (organization_id, contact_id, type, amount_minor, currency, exchange_rate,
       base_amount_minor, payment_date, method, reference, created_by)
    values (${orgId}, ${args.type === 'received' ? customerId : vendorId}, ${args.type},
       ${args.amountMinor.toString()}, ${args.currency}, ${scaledRate.toString()},
       ${args.baseAmountMinor.toString()}, ${args.paymentDate}::date, 'bank_transfer',
       ${args.reference}, ${ownerId})
    returning id
  `;
  await admin`
    insert into payment_items (payment_id, invoice_id, bill_id, amount_minor)
    values (${payment.id}, ${args.invoiceId ?? null}, ${args.billId ?? null},
            ${args.allocatedMinor.toString()})
  `;
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-stmt-${suffix}@example.com`, 'Owner');

  const org = await createTestOrgWithSeed(ownerId, 'Stmt Co', `stmt-co-${suffix}`, 'MYR');
  orgId = org.id;

  const [customer] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'customer', 'Stmt Customer') returning id
  `;
  customerId = customer.id as string;
  const [vendor] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'vendor', 'Stmt Vendor') returning id
  `;
  vendorId = vendor.id as string;
});

afterAll(async () => {
  await admin`
    delete from payment_items
    where payment_id in (select id from payments where organization_id = ${orgId})
  `;
  await admin`delete from payments where organization_id = ${orgId}`;
  await admin`delete from credit_notes where organization_id = ${orgId}`;
  await admin`delete from invoices where organization_id = ${orgId}`;
  await admin`delete from bills where organization_id = ${orgId}`;
  await resetTestData();
  await admin.end();
});

describe('getVendorStatement', () => {
  it('期初 / 期间 / 期末：从跑不起来的 SQL 变成一份能对的账', async () => {
    // 期初（早于 from）：账单 1,000.00
    await insertBill({ totalMinor: 100000n, issueDate: '2026-02-01' });
    // 期间：账单 500.00
    await insertBill({ totalMinor: 50000n, issueDate: '2026-03-05' });
    const paidBill = await insertBill({ totalMinor: 40000n, issueDate: '2026-03-08' });
    // 期间：付款 300.00 核销上一张
    await insertPayment({
      type: 'made',
      currency: 'MYR',
      amountMinor: 30000n,
      baseAmountMinor: 30000n,
      paymentDate: '2026-03-10',
      reference: 'PAY-1',
      billId: paidBill,
      allocatedMinor: 30000n,
    });
    // 期后（晚于 to）：绝不能出现
    await insertBill({ totalMinor: 999900n, issueDate: '2026-04-01' });

    const statement = await withTransaction(ownerId, (tx) =>
      getVendorStatement(tx, orgId, vendorId, '2026-03-01', '2026-03-31'),
    );

    expect(statement.openingBalance).toBe(100000n);
    expect(statement.lines.map((l) => l.amount)).toEqual([50000n, 40000n, -30000n]);
    expect(statement.closingBalance).toBe(100000n + 50000n + 40000n - 30000n);
    // 递进余额必须收在 closingBalance 上。
    expect(statement.lines.at(-1)!.balance).toBe(statement.closingBalance);
    expect(statement.notice).toBeNull();
  });

  it('付款按分摊比例换算成本位币，而不是原样当本位币用', async () => {
    const usdBill = await insertBill({ totalMinor: 20000n, issueDate: '2026-05-01' });
    // USD 100.00 的付款 @ 4.20 = RM 420.00，其中 USD 60.00 分摊到这张账单
    // → RM 252.00。旧写法会直接把 6000（USD 60.00 的 minor）当本位币减掉。
    await insertPayment({
      type: 'made',
      currency: 'USD',
      amountMinor: 10000n,
      baseAmountMinor: 42000n,
      paymentDate: '2026-05-10',
      reference: 'PAY-USD',
      billId: usdBill,
      allocatedMinor: 6000n,
    });

    const statement = await withTransaction(ownerId, (tx) =>
      getVendorStatement(tx, orgId, vendorId, '2026-05-10', '2026-05-31'),
    );

    const payment = statement.lines.find((l) => l.reference === 'PAY-USD')!;
    expect(payment.amount).toBe(-25200n);
  });

  it('未过账的外币账单不进金额，只进 notice', async () => {
    seq += 1;
    await admin`
      insert into bills
        (organization_id, contact_id, bill_number, status, issue_date, due_date, currency,
         total_minor, subtotal_minor)
      values (${orgId}, ${vendorId}, ${`ST-BILL-${suffix}-${seq}`}, 'received',
         '2026-06-01'::date, '2026-06-30'::date, 'SGD', 70000, 70000)
    `;

    const statement = await withTransaction(ownerId, (tx) =>
      getVendorStatement(tx, orgId, vendorId, '2026-06-01', '2026-06-30'),
    );

    expect(statement.lines).toEqual([]);
    expect(statement.notice).toEqual({ count: 1, currencies: ['SGD'] });
  });
});

describe.skipIf(!creditNoteTransactionIdExists)(
  'getCustomerStatement（需要迁移 0021 的 credit_notes.transaction_id）',
  () => {
    it('发票为正、收款与贷项通知单为负，期初期末对得上', async () => {
      await insertInvoice({ totalMinor: 100000n, issueDate: '2026-02-01' });
      const marchInvoice = await insertInvoice({ totalMinor: 50000n, issueDate: '2026-03-05' });
      await insertPayment({
        type: 'received',
        currency: 'MYR',
        amountMinor: 30000n,
        baseAmountMinor: 30000n,
        paymentDate: '2026-03-10',
        reference: 'RCV-1',
        invoiceId: marchInvoice,
        allocatedMinor: 30000n,
      });
      seq += 1;
      await admin`
        insert into credit_notes
          (organization_id, invoice_id, contact_id, cn_number, status, issue_date,
           currency, exchange_rate, base_amount_minor, created_by)
        values (${orgId}, ${marchInvoice}, ${customerId}, ${`ST-CN-${suffix}-${seq}`},
           'issued', '2026-03-12'::date, 'MYR', 100000000, 10000, ${ownerId})
      `;
      // 草稿发票不算
      await insertInvoice({ totalMinor: 777700n, issueDate: '2026-03-15', status: 'draft' });

      const statement = await withTransaction(ownerId, (tx) =>
        getCustomerStatement(tx, orgId, customerId, '2026-03-01', '2026-03-31'),
      );

      expect(statement.openingBalance).toBe(100000n);
      expect(statement.closingBalance).toBe(100000n + 50000n - 30000n - 10000n);
      // 按发生日期排序：发票 03-05 → 收款 03-10 → 贷项通知单 03-12。
      //
      // 这条断言原来写的是 [-10000n, 50000n, -30000n]，也就是把贷项通知单
      // 排在最前面——既不是日期顺序，也不是 SQL 里 union 各分支的顺序。
      // 它之所以能以错误的形态留下来，是因为整个 describe 依赖
      // credit_notes.transaction_id（迁移 0021 才加的列），在迁移执行之前
      // 一直被跳过，作者从没见过它真的跑起来。
      //
      // 对账单必须按时间排：客户拿着它对自己的流水，顺序错了就对不上。
      // getCustomerStatement 的 SQL 尾部是 order by event_date, description,
      // reference，实现一直是对的。
      expect(statement.lines.map((l) => l.amount)).toEqual([50000n, -30000n, -10000n]);
      expect(statement.lines.map((l) => l.date)).toEqual([
        '2026-03-05',
        '2026-03-10',
        '2026-03-12',
      ]);
      expect(statement.notice).toBeNull();
    });
  },
);
