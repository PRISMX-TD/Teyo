import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { listTransactions } from '@/server/repositories/transactions';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
} from '@/tests/helpers/test-db';

let ownerId: string;
let staffId: string;
let orgId: string;
let cashId: string;
let bankId: string;
let rentCategoryId: string;
let salesCategoryId: string;

const suffix = randomUUID().slice(0, 8);

/** 直接插数据，绕过 Action，让列表测试与创建逻辑解耦。 */
async function insertTx(args: {
  kind: 'income' | 'expense';
  occurredOn: string;
  amountMinor: number;
  createdBy: string;
  moneyAccountId: string;
  categoryId: string;
  description: string;
  voided?: boolean;
}) {
  const [row] = await admin`
    insert into transactions (
      organization_id, kind, occurred_on, description, currency,
      amount_minor, base_amount_minor, exchange_rate, rate_source,
      category_id, created_by, client_uuid, voided_at, voided_by, void_reason
    ) values (
      ${orgId}, ${args.kind}, ${args.occurredOn}, ${args.description}, 'MYR',
      ${args.amountMinor}, ${args.amountMinor}, 1, 'auto',
      ${args.categoryId}, ${args.createdBy}, ${randomUUID()},
      ${args.voided ? admin`now()` : null},
      ${args.voided ? args.createdBy : null},
      ${args.voided ? 'test void' : null}
    )
    returning id
  `;

  const [category] = await admin`select account_id from categories where id = ${args.categoryId}`;
  const counterAccount = category.account_id as string;

  const debitId = args.kind === 'expense' ? counterAccount : args.moneyAccountId;
  const creditId = args.kind === 'expense' ? args.moneyAccountId : counterAccount;

  // 两行必须一条语句插完。逐行插的话每次自动提交时分录都是单边不平衡，
  // journal_lines_balanced 这个延迟约束触发器会在提交点回滚整条语句——
  // 更糟的是 postgres.js 的管线模式吞掉了那个异常，调用方看到的是成功，
  // 但库里一行都没有。排查这个假象花的时间远超写对它的成本。
  await admin`
    insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
    values
      (${row.id}, ${orgId}, ${debitId}, 'debit', ${args.amountMinor}, ${args.amountMinor}),
      (${row.id}, ${orgId}, ${creditId}, 'credit', ${args.amountMinor}, ${args.amountMinor})
  `;

  return row.id as string;
}

beforeAll(async () => {
  await resetTestData();
  ownerId = await createTestUser(`test-owner-list-${suffix}@example.com`, 'Owner');
  staffId = await createTestUser(`test-staff-list-${suffix}@example.com`, 'Staff');

  const org = await createTestOrgWithSeed(ownerId, 'List Co', `list-co-${suffix}`, 'MYR');
  orgId = org.id;
  cashId = org.accountsByCode.cash;
  bankId = org.accountsByCode.bank;
  rentCategoryId = org.categoriesByAccountCode.rent;
  salesCategoryId = org.categoriesByAccountCode.sales;
  await joinOrg(staffId, orgId, 'bookkeeper');

  await insertTx({
    kind: 'expense',
    occurredOn: '2026-07-05',
    amountMinor: 10000,
    createdBy: ownerId,
    moneyAccountId: cashId,
    categoryId: rentCategoryId,
    description: 'July rent',
  });
  await insertTx({
    kind: 'expense',
    occurredOn: '2026-08-01',
    amountMinor: 50000,
    createdBy: staffId,
    moneyAccountId: bankId,
    categoryId: rentCategoryId,
    description: 'August rent',
  });
  await insertTx({
    kind: 'income',
    occurredOn: '2026-08-02',
    amountMinor: 120000,
    createdBy: ownerId,
    moneyAccountId: bankId,
    categoryId: salesCategoryId,
    description: 'Shop sales',
  });
  await insertTx({
    kind: 'expense',
    occurredOn: '2026-08-03',
    amountMinor: 7500,
    createdBy: staffId,
    moneyAccountId: cashId,
    categoryId: rentCategoryId,
    description: 'Voided one',
    voided: true,
  });
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

function query(filters: Parameters<typeof listTransactions>[2]) {
  return withTransaction(ownerId, (tx) =>
    listTransactions(tx, orgId, filters, { limit: 50, offset: 0 }),
  );
}

describe('listTransactions', () => {
  it('excludes voided records by default', async () => {
    const { rows, total } = await query({});
    expect(total).toBe(3);
    expect(rows.some((r) => r.description === 'Voided one')).toBe(false);
  });

  it('includes voided records when asked', async () => {
    const { rows, total } = await query({ includeVoided: true });
    expect(total).toBe(4);
    const voided = rows.find((r) => r.description === 'Voided one');
    expect(voided?.voidedAt).toBeTruthy();
    expect(voided?.voidReason).toBe('test void');
  });

  it('returns newest first', async () => {
    const { rows } = await query({});
    expect(rows.map((r) => r.occurredOn)).toEqual(['2026-08-02', '2026-08-01', '2026-07-05']);
  });

  it('filters by date range inclusively', async () => {
    const { rows } = await query({ from: '2026-08-01', to: '2026-08-02' });
    expect(rows.map((r) => r.description).sort()).toEqual(['August rent', 'Shop sales']);
  });

  it('filters by kind', async () => {
    const { rows } = await query({ kind: 'income' });
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('Shop sales');
  });

  it('filters by category', async () => {
    const { rows } = await query({ categoryId: salesCategoryId });
    expect(rows).toHaveLength(1);
  });

  it('filters by money account using the journal lines', async () => {
    const { rows } = await query({ moneyAccountId: cashId });
    expect(rows.map((r) => r.description)).toEqual(['July rent']);
  });

  it('filters by the member who created the record', async () => {
    const { rows } = await query({ createdBy: staffId });
    expect(rows.map((r) => r.description)).toEqual(['August rent']);
  });

  it('filters by amount range on the base amount', async () => {
    const { rows } = await query({ minAmount: '200.00', maxAmount: '600.00' });
    expect(rows.map((r) => r.description)).toEqual(['August rent']);
  });

  it('searches the description case-insensitively', async () => {
    const { rows } = await query({ keyword: 'RENT' });
    expect(rows.map((r) => r.description).sort()).toEqual(['August rent', 'July rent']);
  });

  it('combines several filters', async () => {
    const { rows } = await query({ from: '2026-08-01', kind: 'expense', createdBy: staffId });
    expect(rows.map((r) => r.description)).toEqual(['August rent']);
  });

  it('reports the total independently of the page size', async () => {
    const firstPage = await withTransaction(ownerId, (tx) =>
      listTransactions(tx, orgId, {}, { limit: 2, offset: 0 }),
    );
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.total).toBe(3);
  });

  it('attaches the category name, money account name and creator name', async () => {
    const { rows } = await query({ kind: 'income' });
    expect(rows[0].categoryNameEn).toBe('Sales');
    expect(rows[0].moneyAccountNameEn).toBe('Bank Account');
    expect(rows[0].createdByName).toBe('Owner');
  });

  // 同一 owner 同属两家公司时 RLS 对两边都放行，所以这里量的是查询自身的
  // organization_id 收窄，而不是策略。换成"别人的公司"就会变成假阳性。
  it('never returns rows from another company the same user owns', async () => {
    const other = await createTestOrgWithSeed(
      ownerId,
      'Leak Co',
      `leak-co-${suffix}`,
      'MYR',
    );
    const [leaked] = await admin`
      insert into transactions (
        organization_id, kind, occurred_on, description, currency,
        amount_minor, base_amount_minor, exchange_rate, rate_source,
        category_id, created_by, client_uuid
      ) values (
        ${other.id}, 'expense', '2026-08-04', 'Other company rent', 'MYR',
        6600, 6600, 1, 'auto',
        ${other.categoriesByAccountCode.rent}, ${ownerId}, ${randomUUID()}
      )
      returning id
    `;
    await admin`
      insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
      values
        (${leaked.id}, ${other.id}, ${other.accountsByCode.rent}, 'debit', 6600, 6600),
        (${leaked.id}, ${other.id}, ${other.accountsByCode.cash}, 'credit', 6600, 6600)
    `;

    const { rows, total } = await query({ includeVoided: true });
    expect(rows.some((r) => r.description === 'Other company rent')).toBe(false);
    expect(total).toBe(4);
  });
});
