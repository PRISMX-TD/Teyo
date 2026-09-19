/**
 * 首页 KPI：公司时区下的「今天」、资金余额的日期上界、以及应收/应付
 * 复用账龄那套未结余额定义。
 *
 * 钉住的缺陷（详见 server/repositories/dashboard.ts 的注释）：
 *   1. 「今天/本月」取服务端 UTC，organizations.timezone 从未被读取；
 *   2. total_bank_balance 没有 occurred_on 上界，未来日期的交易被算进余额；
 *   3. unpaid_invoices / unpaid_bills 把各币种原币金额直接相加当本位币展示。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';
import {
  getBankBalances,
  getDashboardKpis,
  getOrganizationToday,
} from '@/server/repositories/dashboard';

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let orgId: string;
let accountsByCode: Record<string, string>;
let customerId: string;
let vendorId: string;
let today: string;

/** 按天平移一个 YYYY-MM-DD，走 Date.UTC 以免把本机时区又牵扯进来。 */
function shiftDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function insertBalancedTransaction(args: {
  occurredOn: string;
  amountMinor: bigint;
  debitAccountId: string;
  creditAccountId: string;
}): Promise<void> {
  const [txn] = await admin`
    insert into transactions
      (organization_id, kind, occurred_on, description, currency,
       amount_minor, base_amount_minor, exchange_rate, category_id,
       created_by, client_uuid)
    values (${orgId}, 'transfer', ${args.occurredOn}::date, 'kpi fixture', 'MYR',
       ${args.amountMinor.toString()}, ${args.amountMinor.toString()}, 1, null,
       ${ownerId}, gen_random_uuid())
    returning id
  `;
  await admin`
    insert into journal_lines
      (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
    values
      (${txn.id}, ${orgId}, ${args.debitAccountId}, 'debit', ${args.amountMinor.toString()}, ${args.amountMinor.toString()}),
      (${txn.id}, ${orgId}, ${args.creditAccountId}, 'credit', ${args.amountMinor.toString()}, ${args.amountMinor.toString()})
  `;
}

let invoiceSeq = 0;
let billSeq = 0;

async function insertInvoice(args: {
  totalMinor: bigint;
  issueDate: string;
  dueDate: string;
  currency?: string;
}): Promise<string> {
  invoiceSeq += 1;
  const [row] = await admin`
    insert into invoices
      (organization_id, contact_id, invoice_number, status, issue_date, due_date,
       currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor)
    values (${orgId}, ${customerId}, ${`KPI-INV-${suffix}-${invoiceSeq}`}, 'sent',
       ${args.issueDate}::date, ${args.dueDate}::date, ${args.currency ?? 'MYR'},
       ${args.totalMinor.toString()}, 0, 0, ${args.totalMinor.toString()})
    returning id
  `;
  return row.id as string;
}

async function insertBill(args: {
  totalMinor: bigint;
  issueDate: string;
  dueDate: string;
}): Promise<string> {
  billSeq += 1;
  const [row] = await admin`
    insert into bills
      (organization_id, contact_id, bill_number, status, issue_date, due_date,
       currency, total_minor, subtotal_minor)
    values (${orgId}, ${vendorId}, ${`KPI-BILL-${suffix}-${billSeq}`}, 'received',
       ${args.issueDate}::date, ${args.dueDate}::date, 'MYR', ${args.totalMinor.toString()},
       ${args.totalMinor.toString()})
    returning id
  `;
  return row.id as string;
}

async function payInvoice(invoiceId: string, minor: bigint, paymentDate: string): Promise<void> {
  const [payment] = await admin`
    insert into payments
      (organization_id, contact_id, type, amount_minor, currency, exchange_rate,
       base_amount_minor, payment_date, method, created_by)
    values (${orgId}, ${customerId}, 'received', ${minor.toString()}, 'MYR', 100000000,
       ${minor.toString()}, ${paymentDate}::date, 'bank_transfer', ${ownerId})
    returning id
  `;
  await admin`
    insert into payment_items (payment_id, invoice_id, amount_minor)
    values (${payment.id}, ${invoiceId}, ${minor.toString()})
  `;
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`owner-kpi-${suffix}@example.com`, 'Owner');

  const org = await createTestOrgWithSeed(ownerId, 'KPI Co', `kpi-co-${suffix}`, 'MYR');
  orgId = org.id;
  accountsByCode = org.accountsByCode;

  const [customer] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'customer', 'KPI Customer') returning id
  `;
  customerId = customer.id as string;
  const [vendor] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'vendor', 'KPI Vendor') returning id
  `;
  vendorId = vendor.id as string;

  today = await withTransaction(ownerId, (tx) => getOrganizationToday(tx, orgId));
});

afterAll(async () => {
  await admin`
    delete from payment_items
    where payment_id in (select id from payments where organization_id = ${orgId})
  `;
  await admin`delete from payments where organization_id = ${orgId}`;
  await admin`delete from invoices where organization_id = ${orgId}`;
  await admin`delete from bills where organization_id = ${orgId}`;
  await resetTestData();
  await admin.end();
});

describe('getOrganizationToday', () => {
  it('真的读了 organizations.timezone，而不是服务端 UTC', async () => {
    // +14 与 −11 相差 25 小时：无论此刻是哪一瞬间，两地的本地日期必然不同。
    // 如果这个函数还在用 `new Date().toISOString()`，两家公司会拿到同一天，
    // 这条断言就会失败。
    const east = await createTestOrgWithSeed(ownerId, 'East Co', `east-co-${suffix}`, 'MYR');
    const west = await createTestOrgWithSeed(ownerId, 'West Co', `west-co-${suffix}`, 'MYR');
    await admin`update organizations set timezone = 'Pacific/Kiritimati' where id = ${east.id}`;
    await admin`update organizations set timezone = 'Pacific/Midway' where id = ${west.id}`;

    const eastToday = await withTransaction(ownerId, (tx) => getOrganizationToday(tx, east.id));
    const westToday = await withTransaction(ownerId, (tx) => getOrganizationToday(tx, west.id));

    expect(eastToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(eastToday).not.toBe(westToday);
    expect(eastToday > westToday).toBe(true);
  });

  it('时区值非法时退回 UTC，而不是把整张首页变成 500', async () => {
    // lib/schemas.ts 对 timezone 只校验「非空、不超过 60 字」，
    // 一个非法的 IANA 名称是能落库的。
    const broken = await createTestOrgWithSeed(ownerId, 'Broken Co', `broken-co-${suffix}`, 'MYR');
    await admin`update organizations set timezone = 'Not/AZone' where id = ${broken.id}`;

    const resolved = await withTransaction(ownerId, (tx) => getOrganizationToday(tx, broken.id));
    const [row] = await admin`select to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as d`;
    expect(resolved).toBe(row.d);
  });

  it('公司不存在时抛错，而不是安静地返回一个 UTC 的今天', async () => {
    await expect(
      withTransaction(ownerId, (tx) => getOrganizationToday(tx, randomUUID())),
    ).rejects.toThrow(/not found/);
  });
});

describe('getDashboardKpis - 资金余额的日期上界', () => {
  it('未来日期的交易不计入现在的银行余额', async () => {
    // 今天：借现金 500.00 / 贷股本
    await insertBalancedTransaction({
      occurredOn: today,
      amountMinor: 50000n,
      debitAccountId: accountsByCode.cash,
      creditAccountId: accountsByCode.capital,
    });
    // 明天（预录的下月房租之类）：借现金 9,999.00 / 贷股本
    await insertBalancedTransaction({
      occurredOn: shiftDays(today, 1),
      amountMinor: 999900n,
      debitAccountId: accountsByCode.cash,
      creditAccountId: accountsByCode.capital,
    });

    const kpis = await withTransaction(ownerId, (tx) => getDashboardKpis(tx, orgId));
    // 旧写法没有 occurred_on 条件，这里会是 1049900。
    expect(kpis.totalBankBalance).toBe(50000n);
  });

  it('明细（getBankBalances）逐条加起来必须等于合计', async () => {
    const [kpis, balances] = await Promise.all([
      withTransaction(ownerId, (tx) => getDashboardKpis(tx, orgId)),
      withTransaction(ownerId, (tx) => getBankBalances(tx, orgId)),
    ]);

    const sum = balances.reduce((total, b) => total + b.balance, 0n);
    expect(sum).toBe(kpis.totalBankBalance);
  });

  it('归档但仍有余额的资金账户，明细与合计都要留着它（I10）', async () => {
    await admin`update accounts set is_active = false where id = ${accountsByCode.cash}`;

    const [kpis, balances] = await Promise.all([
      withTransaction(ownerId, (tx) => getDashboardKpis(tx, orgId)),
      withTransaction(ownerId, (tx) => getBankBalances(tx, orgId)),
    ]);

    expect(balances.some((b) => b.accountId === accountsByCode.cash)).toBe(true);
    expect(kpis.totalBankBalance).toBe(50000n);
    expect(balances.reduce((total, b) => total + b.balance, 0n)).toBe(kpis.totalBankBalance);

    await admin`update accounts set is_active = true where id = ${accountsByCode.cash}`;
  });
});

describe('getDashboardKpis - 应收 / 应付', () => {
  it('未结金额扣掉已收款，逾期按到期日算', async () => {
    // 已逾期 10 天、收了一半
    const overdueInvoice = await insertInvoice({
      totalMinor: 100000n,
      issueDate: shiftDays(today, -40),
      dueDate: shiftDays(today, -10),
    });
    await payInvoice(overdueInvoice, 40000n, shiftDays(today, -5));
    // 还没到期
    await insertInvoice({
      totalMinor: 30000n,
      issueDate: shiftDays(today, -3),
      dueDate: shiftDays(today, 20),
    });
    // 应付：逾期 5 天
    await insertBill({
      totalMinor: 70000n,
      issueDate: shiftDays(today, -20),
      dueDate: shiftDays(today, -5),
    });

    const kpis = await withTransaction(ownerId, (tx) => getDashboardKpis(tx, orgId));

    // 旧写法是 sum(total_minor)，会给出 100000 + 30000 = 130000。
    expect(kpis.unpaidInvoices).toBe(60000n + 30000n);
    expect(kpis.overdueInvoices).toBe(60000n);
    expect(kpis.unpaidBills).toBe(70000n);
    expect(kpis.overdueBills).toBe(70000n);
  });

  it('未过账的外币发票宁可少算也不按 1:1 混进本位币合计', async () => {
    await insertInvoice({
      totalMinor: 100000n,
      issueDate: shiftDays(today, -2),
      dueDate: shiftDays(today, 30),
      currency: 'USD',
    });

    const kpis = await withTransaction(ownerId, (tx) => getDashboardKpis(tx, orgId));
    // 旧写法会把这 100000 当成 RM 1,000.00 加进去。
    expect(kpis.unpaidInvoices).toBe(90000n);
  });
});
