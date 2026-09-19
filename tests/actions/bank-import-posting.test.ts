import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

/**
 * 从银行对账单行**生成**交易。
 *
 * 改动之前，server/actions/bank_import.ts 全文没有一次 postJournal 调用：
 * 导进来的对账单行只能匹配到用户**已经手工记过**的交易。而银行导入最省事
 * 的用法恰恰是反过来——把银行给的流水直接变成账。
 *
 * 这一份钉的是：金额的正负决定收支方向、生成的交易真的进总账、同一行不会
 * 被记两次、以及批量里某一行失败时能指出是哪一行。
 */

let currentUserId: string | null = null;
vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
  requireUserId: () => Promise.resolve(currentUserId),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { postImportedTransactions } = await import('@/server/actions/bank_import');

const suffix = randomUUID().slice(0, 8);
const DAY = '2033-06-15';

let ownerId = '';
let orgId = '';
let orgSlug = '';
let bankAccountId = '';
let incomeCategoryId = '';
let expenseCategoryId = '';

/** 插一条待处理的对账单行。amountMinor 为负表示钱出去了。 */
async function importRow(amountMinor: bigint, description: string): Promise<string> {
  const [row] = await admin`
    insert into imported_transactions
      (organization_id, money_account_id, source, transaction_date,
       amount_minor, description, created_by, status)
    values (${orgId}, ${bankAccountId}, 'csv', ${DAY}::date,
       ${amountMinor.toString()}, ${description}, ${ownerId}, 'pending')
    returning id
  `;
  return row.id as string;
}

async function balanceOf(code: string): Promise<bigint> {
  const [row] = await admin`
    select coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                             else -l.base_amount_minor end), 0) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    join accounts a on a.id = l.account_id
    where l.organization_id = ${orgId} and a.code = ${code} and t.voided_at is null
  `;
  return BigInt(row.net as string);
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-bankpost-${suffix}@example.com`, 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Bank Post Co', `bankpost-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  currentUserId = ownerId;

  const [bank] = await admin`
    select id from accounts where organization_id = ${orgId} and code = 'bank'
  `;
  bankAccountId = bank.id as string;

  const categories = await admin`
    select c.id, a.code from categories c
    join accounts a on a.id = c.account_id
    where c.organization_id = ${orgId} and a.code in ('sales', 'rent')
  `;
  incomeCategoryId = categories.find((c) => c.code === 'sales')?.id as string;
  expenseCategoryId = categories.find((c) => c.code === 'rent')?.id as string;
});

afterAll(async () => {
  await resetTestData();
});

describe('postImportedTransactions', () => {
  it('正数记成收入：借银行 / 贷收入', async () => {
    const id = await importRow(250_00n, 'Customer payment');
    const before = { bank: await balanceOf('bank'), sales: await balanceOf('sales') };

    const result = await postImportedTransactions(orgSlug, {
      entries: [{ importedTransactionId: id, categoryId: incomeCategoryId }],
    });

    expect(result.created).toBe(1);
    expect(await balanceOf('bank')).toBe(before.bank + 250_00n);
    expect(await balanceOf('sales')).toBe(before.sales - 250_00n);
  });

  it('负数记成支出：借费用 / 贷银行', async () => {
    const id = await importRow(-80_00n, 'Office rent');
    const before = { bank: await balanceOf('bank'), rent: await balanceOf('rent') };

    await postImportedTransactions(orgSlug, {
      entries: [{ importedTransactionId: id, categoryId: expenseCategoryId }],
    });

    // 钱出去了：银行减少，费用增加。方向写反不会有任何报错——一借一贷
    // 照样配平，只是每一笔支出都被记成了收入。
    expect(await balanceOf('bank')).toBe(before.bank - 80_00n);
    expect(await balanceOf('rent')).toBe(before.rent + 80_00n);
  });

  it('生成的交易真的落进了总账，并回指到那条对账单行', async () => {
    const id = await importRow(33_00n, 'Interest');
    await postImportedTransactions(orgSlug, {
      entries: [{ importedTransactionId: id, categoryId: incomeCategoryId }],
    });

    const [row] = await admin`
      select status, matched_transaction_id from imported_transactions where id = ${id}
    `;
    expect(row.status).toBe('matched');
    expect(row.matched_transaction_id).not.toBeNull();

    const [txn] = await admin`
      select kind, amount_minor, currency from transactions
      where id = ${row.matched_transaction_id}
    `;
    expect(txn.kind).toBe('income');
    expect(BigInt(txn.amount_minor as string)).toBe(33_00n);
    expect(txn.currency).toBe('MYR');

    const lines = await admin`
      select count(*)::int as n from journal_lines
      where transaction_id = ${row.matched_transaction_id}
    `;
    expect(lines[0].n).toBe(2);
  });

  it('同一行第二次提交被跳过，不会记两笔', async () => {
    const id = await importRow(12_00n, 'Refund');
    const first = await postImportedTransactions(orgSlug, {
      entries: [{ importedTransactionId: id, categoryId: incomeCategoryId }],
    });
    expect(first.created).toBe(1);

    const second = await postImportedTransactions(orgSlug, {
      entries: [{ importedTransactionId: id, categoryId: incomeCategoryId }],
    });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);

    const [count] = await admin`
      select count(*)::int as n from transactions
      where organization_id = ${orgId} and description = 'Refund'
    `;
    expect(count.n).toBeLessThanOrEqual(1);
  });

  it('同一批里列了两次同一行，直接拒掉', async () => {
    // 靠「只处理 pending」去重的话，第二条能被挡住只是因为第一条已经把
    // status 改成了 matched——一个靠副作用生效的去重。说出调用方真正犯的错。
    const id = await importRow(9_00n, 'Dup');
    await expect(
      postImportedTransactions(orgSlug, {
        entries: [
          { importedTransactionId: id, categoryId: incomeCategoryId },
          { importedTransactionId: id, categoryId: incomeCategoryId },
        ],
      }),
    ).rejects.toThrow(/twice/i);
  });

  it('别家公司的对账单行看不见也记不了', async () => {
    const otherOwner = await createTestUser(`test-other-bankpost-${suffix}@example.com`, 'Other');
    const otherOrg = await createTestOrgWithSeed(
      otherOwner,
      'Other Co',
      `other-bankpost-${suffix}`,
      'MYR',
    );
    const [otherBank] = await admin`
      select id from accounts where organization_id = ${otherOrg.id} and code = 'bank'
    `;
    const [foreign] = await admin`
      insert into imported_transactions
        (organization_id, money_account_id, source, transaction_date,
         amount_minor, description, created_by, status)
      values (${otherOrg.id}, ${otherBank.id}, 'csv', ${DAY}::date,
         5000, 'Not yours', ${otherOwner}, 'pending')
      returning id
    `;

    await expect(
      postImportedTransactions(orgSlug, {
        entries: [{ importedTransactionId: foreign.id as string, categoryId: incomeCategoryId }],
      }),
    ).rejects.toThrow();

    // 而且那一行原封未动。
    const [after] = await admin`
      select status, matched_transaction_id from imported_transactions where id = ${foreign.id}
    `;
    expect(after.status).toBe('pending');
    expect(after.matched_transaction_id).toBeNull();
  });

  it('批量里某一行出错时，报错指得出是第几行', async () => {
    const good = await importRow(10_00n, 'Good line');
    const bad = await importRow(-10_00n, 'Bad line');

    // 给一笔支出配一个收入分类——kind 对不上，postJournal 会拒。
    await expect(
      postImportedTransactions(orgSlug, {
        entries: [
          { importedTransactionId: good, categoryId: incomeCategoryId },
          { importedTransactionId: bad, categoryId: incomeCategoryId },
        ],
      }),
    ).rejects.toThrow(/Line 2/);

    // 整批一个事务，第一行也不该留下来。
    const [count] = await admin`
      select count(*)::int as n from transactions
      where organization_id = ${orgId} and description = 'Good line'
    `;
    expect(count.n).toBe(0);
  });

  it('全公司每一笔生成的交易都配平', async () => {
    const [row] = await admin`
      select count(*)::int as n from (
        select t.id
        from transactions t join journal_lines l on l.transaction_id = t.id
        where t.organization_id = ${orgId}
        group by t.id
        having sum(case when l.direction = 'debit' then l.base_amount_minor
                        else -l.base_amount_minor end) <> 0
      ) unbalanced
    `;
    expect(row.n).toBe(0);
  });
});
