/**
 * 应收 / 应付账龄：未结余额、本位币、as-of 上界。
 *
 * 钉住的三条缺陷（详见 server/repositories/aging.ts 的注释）：
 *   1. 按 total_minor 分桶，完全不扣已收/已冲抵的金额；
 *   2. 不同币种的 total_minor 直接相加，再按本位币展示；
 *   3. 没有 as-of 上界，asOf 之后开出的单据也出现在今天的账龄表里。
 *
 * 本文件自建公司，不与别的测试文件共享状态。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';
import {
  getApAging,
  getArAging,
  sumAgingOutstanding,
  sumAgingOverdue,
} from '@/server/repositories/aging';

const suffix = randomUUID().slice(0, 8);

const AS_OF = '2026-06-30';

let ownerId: string;
let orgId: string;
let accountsByCode: Record<string, string>;
let customerId: string;
let vendorId: string;

/** 用例里临时另建的公司，afterAll 要一并清掉它们的单据。 */
const extraOrgIds: string[] = [];

let invoiceSeq = 0;
let billSeq = 0;
let cnSeq = 0;

/**
 * 造一笔「已过账」的交易并返回 id，用来给外币单据提供本位币金额。
 * 借应收 / 贷销售，金额就是这张单据的本位币总额。
 */
async function insertPostedTransaction(args: {
  occurredOn: string;
  currency: string;
  amountMinor: bigint;
  baseAmountMinor: bigint;
  debitAccountId: string;
  creditAccountId: string;
}): Promise<string> {
  const rate = (Number(args.baseAmountMinor) / Number(args.amountMinor)).toFixed(8);
  const [txn] = await admin`
    insert into transactions
      (organization_id, kind, occurred_on, description, currency,
       amount_minor, base_amount_minor, exchange_rate, category_id,
       created_by, client_uuid)
    values (${orgId}, 'journal', ${args.occurredOn}::date, 'aging fixture', ${args.currency},
       ${args.amountMinor.toString()}, ${args.baseAmountMinor.toString()}, ${rate}, null,
       ${ownerId}, gen_random_uuid())
    returning id
  `;
  const txnId = txn.id as string;

  await admin`
    insert into journal_lines
      (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
    values
      (${txnId}, ${orgId}, ${args.debitAccountId}, 'debit',
       ${args.amountMinor.toString()}, ${args.baseAmountMinor.toString()}),
      (${txnId}, ${orgId}, ${args.creditAccountId}, 'credit',
       ${args.amountMinor.toString()}, ${args.baseAmountMinor.toString()})
  `;
  return txnId;
}

async function insertInvoice(args: {
  currency: string;
  totalMinor: bigint;
  issueDate: string;
  dueDate: string;
  status?: string;
  transactionId?: string | null;
  contactId?: string;
}): Promise<string> {
  invoiceSeq += 1;
  const [row] = await admin`
    insert into invoices
      (organization_id, contact_id, invoice_number, status, issue_date, due_date,
       currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor, transaction_id)
    values (${orgId}, ${args.contactId ?? customerId}, ${`INV-${suffix}-${invoiceSeq}`},
       ${args.status ?? 'sent'}, ${args.issueDate}::date, ${args.dueDate}::date,
       ${args.currency}, ${args.totalMinor.toString()}, 0, 0, ${args.totalMinor.toString()},
       ${args.transactionId ?? null})
    returning id
  `;
  return row.id as string;
}

async function insertBill(args: {
  currency: string;
  totalMinor: bigint;
  issueDate: string;
  dueDate: string;
  status?: string;
  transactionId?: string | null;
}): Promise<string> {
  billSeq += 1;
  const [row] = await admin`
    insert into bills
      (organization_id, contact_id, bill_number, status, issue_date, due_date,
       currency, total_minor, subtotal_minor, transaction_id)
    values (${orgId}, ${vendorId}, ${`BILL-${suffix}-${billSeq}`},
       ${args.status ?? 'received'}, ${args.issueDate}::date, ${args.dueDate}::date,
       ${args.currency}, ${args.totalMinor.toString()}, ${args.totalMinor.toString()},
       ${args.transactionId ?? null})
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
  invoiceId?: string;
  billId?: string;
  allocatedMinor: bigint;
  contactId?: string;
  voided?: boolean;
}): Promise<void> {
  const scaledRate = (args.baseAmountMinor * 100_000_000n) / args.amountMinor;
  const [payment] = await admin`
    insert into payments
      (organization_id, contact_id, type, amount_minor, currency, exchange_rate,
       base_amount_minor, payment_date, method, created_by)
    values (${orgId}, ${args.contactId ?? (args.type === 'received' ? customerId : vendorId)},
       ${args.type}, ${args.amountMinor.toString()}, ${args.currency}, ${scaledRate.toString()},
       ${args.baseAmountMinor.toString()}, ${args.paymentDate}::date, 'bank_transfer', ${ownerId})
    returning id
  `;
  await admin`
    insert into payment_items (payment_id, invoice_id, bill_id, amount_minor)
    values (${payment.id}, ${args.invoiceId ?? null}, ${args.billId ?? null},
            ${args.allocatedMinor.toString()})
  `;
  if (args.voided) {
    await admin`update payments set voided_at = now() where id = ${payment.id}`;
  }
}

async function insertCreditNote(args: {
  invoiceId: string;
  currency: string;
  amountMinor: bigint;
  issueDate: string;
  status?: string;
}): Promise<void> {
  cnSeq += 1;
  await admin`
    insert into credit_notes
      (organization_id, invoice_id, contact_id, cn_number, status, issue_date,
       currency, exchange_rate, base_amount_minor, created_by)
    values (${orgId}, ${args.invoiceId}, ${customerId}, ${`CN-${suffix}-${cnSeq}`},
       ${args.status ?? 'issued'}, ${args.issueDate}::date, ${args.currency},
       100000000, ${args.amountMinor.toString()}, ${ownerId})
  `;
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-aging-${suffix}@example.com`, 'Owner');

  const org = await createTestOrgWithSeed(ownerId, 'Aging Co', `aging-co-${suffix}`, 'MYR');
  orgId = org.id;
  accountsByCode = org.accountsByCode;

  const [customer] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'customer', 'Acme Bhd') returning id
  `;
  customerId = customer.id as string;
  const [vendor] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'vendor', 'Supplier Sdn') returning id
  `;
  vendorId = vendor.id as string;
});

afterAll(async () => {
  // payment_items.invoice_id / .bill_id 的外键没有 on delete 动作
  // （0009 建表时就没写，0016/0020 两轮补 cascade 也没覆盖到它），
  // 所以 `delete from organizations` 级联删 invoices 时会被
  // payment_items_invoice_id_fkey 拦下——resetTestData 会整个失败，
  // 连带把本文件建的公司留在生产库里。这里先手工按依赖顺序清掉这几张表。
  // （这是一条真实的生产缺陷：删除一家有收付款记录的公司同样会失败。
  //   已写进交付报告，迁移不在本次可改范围内。）
  for (const id of [orgId, ...extraOrgIds]) {
    await admin`
      delete from payment_items
      where payment_id in (select id from payments where organization_id = ${id})
    `;
    await admin`delete from payments where organization_id = ${id}`;
    await admin`delete from credit_notes where organization_id = ${id}`;
    await admin`delete from invoices where organization_id = ${id}`;
    await admin`delete from bills where organization_id = ${id}`;
  }

  await resetTestData();
  await admin.end();
});

describe('getArAging - 未结余额而不是单据总额', () => {
  it('扣掉已收款与已冲抵的贷项通知单', async () => {
    // 本位币发票 RM 1,000.00，到期日在 asOf 之后 → current 桶。
    const invoiceId = await insertInvoice({
      currency: 'MYR',
      totalMinor: 100000n,
      issueDate: '2026-06-01',
      dueDate: '2026-07-15',
    });
    // 收了 RM 900.00
    await insertPayment({
      type: 'received',
      currency: 'MYR',
      amountMinor: 90000n,
      baseAmountMinor: 90000n,
      paymentDate: '2026-06-10',
      invoiceId,
      allocatedMinor: 90000n,
    });
    // 又开了一张 RM 50.00 的贷项通知单
    await insertCreditNote({
      invoiceId,
      currency: 'MYR',
      amountMinor: 5000n,
      issueDate: '2026-06-12',
    });

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    const acme = rows.find((r) => r.contactName === 'Acme Bhd')!;

    // 旧写法会给出 100000（整张发票）。现在必须是 100000 − 90000 − 5000。
    expect(acme.total).toBe(5000n);
    expect(acme.current).toBe(5000n);
    expect(acme.overdue).toBe(0n);
    expect(rows.every((r) => r.notice === null)).toBe(true);
  });

  it('作废的收款不算核销', async () => {
    const invoiceId = await insertInvoice({
      currency: 'MYR',
      totalMinor: 30000n,
      issueDate: '2026-06-02',
      dueDate: '2026-07-20',
    });
    await insertPayment({
      type: 'received',
      currency: 'MYR',
      amountMinor: 30000n,
      baseAmountMinor: 30000n,
      paymentDate: '2026-06-11',
      invoiceId,
      allocatedMinor: 30000n,
      voided: true,
    });

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    const acme = rows.find((r) => r.contactName === 'Acme Bhd')!;
    // 上一条用例留下 5000，这张 30000 一分钱没收到。
    expect(acme.total).toBe(35000n);
  });

  it('asOf 之后开出的发票不出现在今天的账龄表里', async () => {
    await insertInvoice({
      currency: 'MYR',
      totalMinor: 999900n,
      issueDate: '2026-07-01',
      dueDate: '2026-08-01',
    });

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    const acme = rows.find((r) => r.contactName === 'Acme Bhd')!;
    // 旧写法没有 issue_date 上界，这 999900 会直接混进来。
    expect(acme.total).toBe(35000n);

    // 把 asOf 推到它开出之后，它就该出现了——证明上面那条断言不是靠
    // 「这张单据根本没插进去」侥幸成立的。
    const later = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, '2026-07-31'));
    expect(later.find((r) => r.contactName === 'Acme Bhd')!.total).toBe(35000n + 999900n);
  });

  it('草稿发票不算应收', async () => {
    await insertInvoice({
      currency: 'MYR',
      totalMinor: 777700n,
      issueDate: '2026-06-03',
      dueDate: '2026-07-03',
      status: 'draft',
    });

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    expect(rows.find((r) => r.contactName === 'Acme Bhd')!.total).toBe(35000n);
  });

  it('逾期 1-30 天单独成桶，不再混进「未逾期」', async () => {
    // 到期日 2026-06-20，早于 asOf 6/30 十天 → 逾期 1-30 天那一桶。
    //
    // 这一条以前断言的是它落在 current 里：那时 current 的定义是「到期日在
    // asOf 前 30 天之内**或**尚未到期」，于是表头写着 Current 的那一列里
    // 装着已经欠了十天的钱。账龄表的全部用途就是回答「哪些该去催了」，
    // 而那个分法恰好把最该催的一档藏进了看起来最安全的一列。
    await insertInvoice({
      currency: 'MYR',
      totalMinor: 20000n,
      issueDate: '2026-05-20',
      dueDate: '2026-06-20',
    });
    // 到期日 2026-01-05，早于 asOf 90 天以上 → over90 桶。
    await insertInvoice({
      currency: 'MYR',
      totalMinor: 10000n,
      issueDate: '2026-01-01',
      dueDate: '2026-01-05',
    });

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    const acme = rows.find((r) => r.contactName === 'Acme Bhd')!;

    expect(acme.current).toBe(35000n);
    expect(acme.d1_30).toBe(20000n);
    expect(acme.over90).toBe(10000n);
    expect(acme.total).toBe(65000n);
    expect(acme.overdue).toBe(30000n);

    // 四个逾期桶不重不漏地铺满 due_date < asOf，所以这两条恒等式必须成立。
    // 它们同时挡住「桶的边界改出重叠或空隙」这一类改动——那种错不会让任何
    // 一个数看起来异常，只会让合计对不上。
    expect(acme.d1_30 + acme.d31_60 + acme.d61_90 + acme.over90).toBe(acme.overdue);
    expect(acme.current + acme.overdue).toBe(acme.total);
  });
});

describe('getArAging - 多币种', () => {
  it('已过账的外币发票按它自己的记账汇率换成本位币', async () => {
    // USD 1,000.00 @ 4.20 = RM 4,200.00，已过账。
    const txnId = await insertPostedTransaction({
      occurredOn: '2026-06-05',
      currency: 'USD',
      amountMinor: 100000n,
      baseAmountMinor: 420000n,
      debitAccountId: accountsByCode['accounts-receivable'],
      creditAccountId: accountsByCode.sales,
    });
    const invoiceId = await insertInvoice({
      currency: 'USD',
      totalMinor: 100000n,
      issueDate: '2026-06-05',
      dueDate: '2026-07-05',
      transactionId: txnId,
    });
    // 收了 USD 250.00（部分收款）→ 未结原币 USD 750.00 → RM 3,150.00
    await insertPayment({
      type: 'received',
      currency: 'USD',
      amountMinor: 25000n,
      baseAmountMinor: 105000n,
      paymentDate: '2026-06-20',
      invoiceId,
      allocatedMinor: 25000n,
    });

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    const acme = rows.find((r) => r.contactName === 'Acme Bhd')!;

    // 旧写法会把原币 100000 直接加进合计（当成 RM 1,000.00）。
    // 现在是 65000（本位币发票）+ 315000（USD 750 @ 4.20）。
    expect(acme.total).toBe(65000n + 315000n);
    expect(rows.every((r) => r.notice === null)).toBe(true);
  });

  it('未过账的外币发票被排除，并单列一条提示行', async () => {
    await insertInvoice({
      currency: 'SGD',
      totalMinor: 50000n,
      issueDate: '2026-06-06',
      dueDate: '2026-07-06',
    });
    await insertInvoice({
      currency: 'USD',
      totalMinor: 60000n,
      issueDate: '2026-06-07',
      dueDate: '2026-07-07',
    });

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    const acme = rows.find((r) => r.contactName === 'Acme Bhd')!;

    // 合计一分不变：换不出本位币的单据绝不按 1:1 混进来。
    expect(acme.total).toBe(65000n + 315000n);

    const notice = rows.at(-1)!;
    expect(notice.notice).not.toBeNull();
    expect(notice.notice!.count).toBe(2);
    expect(notice.notice!.currencies).toEqual(['SGD', 'USD']);
    // 提示行的金额必须全是 0，表尾合计才仍然是纯本位币。
    expect(notice.total).toBe(0n);
    expect(notice.current).toBe(0n);
    expect(notice.overdue).toBe(0n);
    expect(notice.contactName).toContain('SGD');
  });

  it('收款币种与发票币种不一致时，同样归入提示行而不是硬减', async () => {
    const invoiceId = await insertInvoice({
      currency: 'MYR',
      totalMinor: 80000n,
      issueDate: '2026-06-08',
      dueDate: '2026-07-08',
    });
    // 用 USD 收款去核销一张 MYR 发票：80000 − 20000 这个减法没有意义。
    await insertPayment({
      type: 'received',
      currency: 'USD',
      amountMinor: 20000n,
      baseAmountMinor: 84000n,
      paymentDate: '2026-06-21',
      invoiceId,
      allocatedMinor: 20000n,
    });

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    const acme = rows.find((r) => r.contactName === 'Acme Bhd')!;

    expect(acme.total).toBe(65000n + 315000n);
    expect(rows.at(-1)!.notice!.count).toBe(3);
    expect(rows.at(-1)!.notice!.currencies).toEqual(['MYR', 'SGD', 'USD']);
  });
});

describe('getApAging', () => {
  it('按未结余额、本位币、as-of 上界，与应收同一套口径', async () => {
    await insertBill({
      currency: 'MYR',
      totalMinor: 200000n,
      issueDate: '2026-06-01',
      dueDate: '2026-06-10',
    });
    const paidBillId = await insertBill({
      currency: 'MYR',
      totalMinor: 150000n,
      issueDate: '2026-06-02',
      dueDate: '2026-07-02',
    });
    await insertPayment({
      type: 'made',
      currency: 'MYR',
      amountMinor: 150000n,
      baseAmountMinor: 150000n,
      paymentDate: '2026-06-15',
      billId: paidBillId,
      allocatedMinor: 150000n,
    });
    // asOf 之后收到的账单
    await insertBill({
      currency: 'MYR',
      totalMinor: 900000n,
      issueDate: '2026-07-05',
      dueDate: '2026-08-05',
    });
    // 草稿
    await insertBill({
      currency: 'MYR',
      totalMinor: 400000n,
      issueDate: '2026-06-03',
      dueDate: '2026-07-03',
      status: 'draft',
    });

    const rows = await withTransaction(ownerId, (tx) => getApAging(tx, orgId, AS_OF));
    const vendor = rows.find((r) => r.contactName === 'Supplier Sdn')!;

    // 只剩第一张 200000：付清的那张余额为 0 自动掉出，
    // 未来的与草稿的都不该出现。
    expect(vendor.total).toBe(200000n);
    expect(vendor.overdue).toBe(200000n);
    expect(rows.every((r) => r.notice === null)).toBe(true);
  });

  it('付清的账单即使 status 还停在 received 也不再出现', async () => {
    // status 从来没有人回写（server/actions/payments.ts 不动它），
    // 所以「付清了」这件事只能从未结余额看出来。
    const rows = await withTransaction(ownerId, (tx) => getApAging(tx, orgId, AS_OF));
    const [statusRow] = await admin`
      select count(*) as n from bills
      where organization_id = ${orgId} and status = 'received'
    `;
    expect(Number(statusRow.n)).toBeGreaterThan(1);
    expect(sumAgingOutstanding(rows)).toBe(200000n);
  });
});

describe('合计辅助函数', () => {
  it('sumAgingOutstanding / sumAgingOverdue 跳过提示行（它全是 0）', async () => {
    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, orgId, AS_OF));
    expect(rows.some((r) => r.notice !== null)).toBe(true);
    expect(sumAgingOutstanding(rows)).toBe(65000n + 315000n);
    expect(sumAgingOverdue(rows)).toBe(30000n);
  });
});

describe('账龄表与总账的 tie-out（单据进总账之后）', () => {
  it('外币发票部分结算后，账龄未结额逐分等于总账应收余额', async () => {
    // 这条用例回答的是「单据接进总账之后，报表仍然自洽」这件事在账龄这一侧
    // 的具体含义：账龄表算出来的未结额，必须等于总账 accounts-receivable
    // 上真正躺着的那个数。两者用的是同一个公式
    // （server/services/fx-settlement.ts 的 clearedBaseMinor），所以它不是
    // 「大致相等」，是逐分相等。
    //
    // 单开一家公司：本文件前面的用例往共享的应收科目上记过账、也留下了
    // 一些没过账的本位币发票，那份夹具里「账龄合计 = 总账应收」本来就不成立
    // （没过账的单据按定义不在总账里）。要验证的是公式本身，不是那份夹具。
    const tieOrg = await createTestOrgWithSeed(ownerId, 'Tie Co', `tie-co-${suffix}`, 'MYR');
    extraOrgIds.push(tieOrg.id);

    const [contact] = await admin`
      insert into contacts (organization_id, type, name)
      values (${tieOrg.id}, 'customer', 'Tie Customer') returning id
    `;
    const tieContactId = contact.id as string;
    const arAccountId = tieOrg.accountsByCode['accounts-receivable'];

    async function journal(
      occurredOn: string,
      currency: string,
      amountMinor: bigint,
      lines: { accountId: string; direction: 'debit' | 'credit'; baseAmountMinor: bigint }[],
    ): Promise<string> {
      const debitBase = lines
        .filter((l) => l.direction === 'debit')
        .reduce((sum, l) => sum + l.baseAmountMinor, 0n);
      const [txn] = await admin`
        insert into transactions
          (organization_id, kind, occurred_on, description, currency,
           amount_minor, base_amount_minor, exchange_rate, category_id, created_by, client_uuid)
        values (${tieOrg.id}, 'journal', ${occurredOn}::date, 'tie fixture', ${currency},
           ${amountMinor.toString()}, ${debitBase.toString()},
           ${(Number(debitBase) / Number(amountMinor)).toFixed(8)}, null,
           ${ownerId}, gen_random_uuid())
        returning id
      `;
      // 全部行一条语句插入：配平触发器是 deferrable initially deferred，
      // 在不开显式事务的连接上逐行插会在提交时回滚，而错误不会被 reject。
      await admin`
        insert into journal_lines ${admin(
          lines.map((l) => ({
            transaction_id: txn.id as string,
            organization_id: tieOrg.id,
            account_id: l.accountId,
            direction: l.direction,
            amount_minor: l.baseAmountMinor.toString(),
            base_amount_minor: l.baseAmountMinor.toString(),
          })),
          'transaction_id',
          'organization_id',
          'account_id',
          'direction',
          'amount_minor',
          'base_amount_minor',
        )}
      `;
      return txn.id as string;
    }

    // 开票：USD 1,000.00 @ 4.70 → 借应收 RM 4,700.00 / 贷销售 RM 4,700.00
    const invoiceTxnId = await journal('2026-05-01', 'USD', 100000n, [
      { accountId: arAccountId, direction: 'debit', baseAmountMinor: 470000n },
      { accountId: tieOrg.accountsByCode.sales, direction: 'credit', baseAmountMinor: 470000n },
    ]);
    const [invoice] = await admin`
      insert into invoices
        (organization_id, contact_id, invoice_number, status, issue_date, due_date,
         currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor, transaction_id)
      values (${tieOrg.id}, ${tieContactId}, ${`TIE-INV-${suffix}`}, 'sent',
         '2026-05-01'::date, '2026-06-01'::date, 'USD', 100000, 0, 0, 100000, ${invoiceTxnId})
      returning id
    `;

    // 部分收款 USD 333.00 @ 4.50 → 实收 RM 1,498.50
    const settledDoc = 33300n;
    const settlementBase = 149850n;
    // fx-settlement.ts 的 clearedBaseMinor：round(470000 × 33300 / 100000) = 156510
    const clearedBase = 156510n;
    const fxLoss = clearedBase - settlementBase; // 6660，马币升值造成的损失

    await journal('2026-05-20', 'USD', settledDoc, [
      { accountId: tieOrg.accountsByCode.bank, direction: 'debit', baseAmountMinor: settlementBase },
      { accountId: arAccountId, direction: 'credit', baseAmountMinor: settlementBase },
    ]);
    // 汇兑调整：纯本位币凭证，借 fx-loss / 贷应收
    await journal('2026-05-20', 'MYR', fxLoss, [
      { accountId: tieOrg.accountsByCode['fx-loss'], direction: 'debit', baseAmountMinor: fxLoss },
      { accountId: arAccountId, direction: 'credit', baseAmountMinor: fxLoss },
    ]);

    const [payment] = await admin`
      insert into payments
        (organization_id, contact_id, type, amount_minor, currency, exchange_rate,
         base_amount_minor, payment_date, method, created_by)
      values (${tieOrg.id}, ${tieContactId}, 'received', ${settledDoc.toString()}, 'USD',
         450000000, ${settlementBase.toString()}, '2026-05-20'::date, 'bank_transfer', ${ownerId})
      returning id
    `;
    await admin`
      insert into payment_items (payment_id, invoice_id, amount_minor)
      values (${payment.id}, ${invoice.id}, ${settledDoc.toString()})
    `;

    // 总账里应收还剩多少
    const [ledger] = await admin`
      select coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                               else -l.base_amount_minor end), 0) as net
      from journal_lines l
      join transactions t on t.id = l.transaction_id
      where l.organization_id = ${tieOrg.id}
        and l.account_id = ${arAccountId}
        and t.voided_at is null
        and t.occurred_on <= '2026-05-31'::date
    `;
    const ledgerAr = BigInt(ledger.net as string);
    expect(ledgerAr).toBe(470000n - clearedBase); // 313490

    const rows = await withTransaction(ownerId, (tx) => getArAging(tx, tieOrg.id, '2026-05-31'));
    expect(rows.every((r) => r.notice === null)).toBe(true);
    // 逐分相等——这正是「先算总额再按比例减去已结算部分」而不是
    // 「未结原币 × 汇率」的理由。
    expect(sumAgingOutstanding(rows)).toBe(ledgerAr);
  });
});
