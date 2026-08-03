import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
  seedRate,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createTransaction } = await import('@/server/actions/transactions');

let ownerId: string;
let viewerId: string;
let orgSlug: string;
let orgId: string;
let cashAccountId: string;
let bankAccountId: string;
let rentCategoryId: string;
let salesCategoryId: string;

// slug 全局唯一，固定值会让上一轮的残留数据卡死后续所有测试。
const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-tx-${suffix}@example.com`, 'Owner');
  viewerId = await createTestUser(`test-viewer-tx-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'Ledger Co', `ledger-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  cashAccountId = org.accountsByCode.cash;
  bankAccountId = org.accountsByCode.bank;
  rentCategoryId = org.categoriesByAccountCode.rent;
  salesCategoryId = org.categoriesByAccountCode.sales;

  await joinOrg(viewerId, orgId, 'viewer');
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

// exchange_rates 是全局共享表，没有公司维度隔离。
// tests/services/exchange-rate-sync.test.ts 会清理 2026-08 整月的汇率，
// 两个文件并行跑时会互相抹掉数据，所以这里的日期一律用 2026-09。
const DAY = '2026-09-01';

function expenseInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'expense' as const,
    occurredOn: DAY,
    amount: '1200.00',
    currency: 'MYR',
    moneyAccountId: cashAccountId,
    categoryId: rentCategoryId,
    description: 'Shop rent August',
    clientUuid: randomUUID(),
    ...overrides,
  };
}

describe('createTransaction - expense', () => {
  it('stores the transaction and a balanced pair of journal lines', async () => {
    currentUserId = ownerId;
    const { id, deduplicated } = await createTransaction(orgSlug, expenseInput());

    expect(deduplicated).toBe(false);

    const [transaction] = await admin`
      select kind, amount_minor, base_amount_minor, exchange_rate, rate_source, created_by
      from transactions where id = ${id}
    `;
    expect(transaction.kind).toBe('expense');
    expect(transaction.amount_minor).toBe('120000');
    expect(transaction.base_amount_minor).toBe('120000');
    expect(Number(transaction.exchange_rate)).toBe(1);
    expect(transaction.created_by).toBe(ownerId);

    const lines = await admin`
      select a.code, l.direction, l.amount_minor
      from journal_lines l join accounts a on a.id = l.account_id
      where l.transaction_id = ${id}
      order by l.direction
    `;
    expect(lines).toEqual([
      { code: 'rent', direction: 'debit', amount_minor: '120000' },
      { code: 'cash', direction: 'credit', amount_minor: '120000' },
    ]);
  });

  it('writes an audit entry in the same transaction', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(orgSlug, expenseInput());

    const rows = await admin`
      select action, after from audit_logs
      where entity_id = ${id} and action = 'transaction.created'
    `;
    expect(rows).toHaveLength(1);
    // jsonb 必须是对象，不是被双重编码的字符串（见 audit-logs.ts 的说明）。
    expect(rows[0].after).toMatchObject({ kind: 'expense' });
  });

  it('stores bigint amounts in the audit snapshot as queryable json', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(orgSlug, expenseInput());

    const [row] = await admin`
      select after->>'amountMinor' as amount from audit_logs
      where entity_id = ${id} and action = 'transaction.created'
    `;
    expect(row.amount).toBe('120000');
  });
});

describe('createTransaction - income and transfer', () => {
  it('debits the money account and credits revenue for income', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(
      orgSlug,
      expenseInput({
        kind: 'income',
        moneyAccountId: bankAccountId,
        categoryId: salesCategoryId,
        amount: '500.00',
      }),
    );

    const lines = await admin`
      select a.code, l.direction from journal_lines l
      join accounts a on a.id = l.account_id
      where l.transaction_id = ${id} order by l.direction
    `;
    expect(lines).toEqual([
      { code: 'bank', direction: 'debit' },
      { code: 'sales', direction: 'credit' },
    ]);
  });

  it('debits the destination and credits the source for a transfer', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(
      orgSlug,
      expenseInput({
        kind: 'transfer',
        amount: '800.00',
        moneyAccountId: bankAccountId,
        counterAccountId: cashAccountId,
        categoryId: undefined,
      }),
    );

    const lines = await admin`
      select a.code, l.direction from journal_lines l
      join accounts a on a.id = l.account_id
      where l.transaction_id = ${id} order by l.direction
    `;
    expect(lines).toEqual([
      { code: 'bank', direction: 'debit' },
      { code: 'cash', direction: 'credit' },
    ]);
  });

  it('rejects a transfer between the same account', async () => {
    currentUserId = ownerId;
    await expect(
      createTransaction(
        orgSlug,
        expenseInput({
          kind: 'transfer',
          moneyAccountId: cashAccountId,
          counterAccountId: cashAccountId,
          categoryId: undefined,
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-money account as the money side', async () => {
    currentUserId = ownerId;
    // rent 是费用科目，不能当作资金账户。
    const [rent] = await admin`
      select id from accounts where organization_id = ${orgId} and code = 'rent'
    `;
    await expect(
      createTransaction(orgSlug, expenseInput({ moneyAccountId: rent.id })),
    ).rejects.toThrow();
  });
});

describe('createTransaction - offline idempotency', () => {
  it('returns the existing record when the same client uuid is submitted twice', async () => {
    currentUserId = ownerId;
    const input = expenseInput();

    const first = await createTransaction(orgSlug, input);
    const second = await createTransaction(orgSlug, input);

    expect(second.id).toBe(first.id);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);

    const rows = await admin`
      select id from transactions
      where organization_id = ${orgId} and client_uuid = ${input.clientUuid}
    `;
    expect(rows).toHaveLength(1);
  });

  it('does not write a second audit entry for a deduplicated submission', async () => {
    currentUserId = ownerId;
    const input = expenseInput();

    const { id } = await createTransaction(orgSlug, input);
    await createTransaction(orgSlug, input);

    const rows = await admin`
      select id from audit_logs where entity_id = ${id} and action = 'transaction.created'
    `;
    expect(rows).toHaveLength(1);
  });

  it('scopes the idempotency key per company', async () => {
    // client_uuid 的唯一约束是 (organization_id, client_uuid)。
    // 同一个 uuid 在另一家公司必须能独立入账，不能被误判为重复。
    const otherOwner = await createTestUser(`test-other-idem-${suffix}@example.com`, 'Other');
    const other = await createTestOrgWithSeed(
      otherOwner,
      'Other Idem Co',
      `other-idem-${suffix}`,
      'MYR',
    );

    const shared = randomUUID();

    currentUserId = ownerId;
    const mine = await createTransaction(orgSlug, expenseInput({ clientUuid: shared }));

    currentUserId = otherOwner;
    const theirs = await createTransaction(other.slug, {
      kind: 'expense' as const,
      occurredOn: DAY,
      amount: '10.00',
      currency: 'MYR',
      moneyAccountId: other.accountsByCode.cash,
      categoryId: other.categoriesByAccountCode.rent,
      description: 'Theirs',
      clientUuid: shared,
    });

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.deduplicated).toBe(false);
  });
});

describe('createTransaction - foreign currency', () => {
  it('auto-fills the cached rate and records rate_source auto', async () => {
    await seedRate('SGD', 'MYR', 3_50000000n, DAY);

    currentUserId = ownerId;
    const { id } = await createTransaction(
      orgSlug,
      expenseInput({ currency: 'SGD', amount: '100.00' }),
    );

    const [row] = await admin`
      select currency, amount_minor, base_amount_minor, exchange_rate, rate_source
      from transactions where id = ${id}
    `;
    expect(row.currency).toBe('SGD');
    expect(row.amount_minor).toBe('10000');
    expect(row.base_amount_minor).toBe('35000');
    expect(row.rate_source).toBe('auto');
  });

  it('honours a manual rate and records rate_source manual', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(
      orgSlug,
      expenseInput({ currency: 'SGD', amount: '100.00', exchangeRate: '3.60' }),
    );

    const [row] = await admin`
      select base_amount_minor, rate_source from transactions where id = ${id}
    `;
    expect(row.base_amount_minor).toBe('36000');
    expect(row.rate_source).toBe('manual');
  });

  it('rejects a foreign currency record when no rate is cached and none is supplied', async () => {
    currentUserId = ownerId;
    await expect(
      createTransaction(orgSlug, expenseInput({ currency: 'THB', amount: '100.00' })),
    ).rejects.toThrow(/rate/i);
  });

  it('records a rate of exactly 1 for the base currency', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(orgSlug, expenseInput());
    const [row] = await admin`select exchange_rate from transactions where id = ${id}`;
    expect(Number(row.exchange_rate)).toBe(1);
  });

  it('keeps journal lines balanced in base currency for a foreign amount', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(
      orgSlug,
      expenseInput({ currency: 'SGD', amount: '33.33', exchangeRate: '3.11' }),
    );

    const [row] = await admin`
      select
        coalesce(sum(base_amount_minor) filter (where direction = 'debit'), 0) as d,
        coalesce(sum(base_amount_minor) filter (where direction = 'credit'), 0) as c
      from journal_lines where transaction_id = ${id}
    `;
    expect(row.d).toBe(row.c);
  });
});

describe('createTransaction - permissions and locking', () => {
  it('blocks a viewer from creating records', async () => {
    currentUserId = viewerId;
    await expect(createTransaction(orgSlug, expenseInput())).rejects.toThrow(/forbidden|cannot/i);
  });

  it('blocks a non-member entirely', async () => {
    const outsiderId = await createTestUser(`test-outsider-${suffix}@example.com`, 'Outsider');
    currentUserId = outsiderId;
    await expect(createTransaction(orgSlug, expenseInput())).rejects.toThrow();
  });

  it('blocks an unauthenticated caller', async () => {
    currentUserId = null;
    await expect(createTransaction(orgSlug, expenseInput())).rejects.toThrow();
  });

  it('refuses a date inside a locked period but allows one after it', async () => {
    await admin`update organizations set locked_until = '2026-08-31' where id = ${orgId}`;

    currentUserId = ownerId;
    await expect(
      createTransaction(orgSlug, expenseInput({ occurredOn: '2026-08-15' })),
    ).rejects.toThrow(/locked/i);

    await expect(
      createTransaction(orgSlug, expenseInput({ occurredOn: '2026-09-02' })),
    ).resolves.toBeTruthy();

    await admin`update organizations set locked_until = null where id = ${orgId}`;
  });

  // 下面两条刻意让 ownerId 同时是第二家公司的 owner。
  // 若换成"别人的公司"，RLS 会先把行挡掉，测试即便在仓储漏掉
  // organization_id 收窄时也照样通过——那是假阳性。用户自建第二家公司
  // 是常态，此时 RLS 全部放行，唯一的防线就是应用层的公司维度收窄。
  it('rejects a money account from another company the same user also owns', async () => {
    const other = await createTestOrgWithSeed(
      ownerId,
      'Second Co',
      `second-co-tx-${suffix}`,
      'MYR',
    );

    currentUserId = ownerId;
    await expect(
      createTransaction(orgSlug, expenseInput({ moneyAccountId: other.accountsByCode.cash })),
    ).rejects.toThrow(/does not exist in this company/i);
  });

  it('rejects a category from another company the same user also owns', async () => {
    const other = await createTestOrgWithSeed(
      ownerId,
      'Third Co',
      `third-co-tx-${suffix}`,
      'MYR',
    );

    currentUserId = ownerId;
    await expect(
      createTransaction(orgSlug, expenseInput({ categoryId: other.categoriesByAccountCode.rent })),
    ).rejects.toThrow(/does not exist in this company/i);
  });

  it('rejects a transfer whose destination is in another company the user owns', async () => {
    const other = await createTestOrgWithSeed(
      ownerId,
      'Fourth Co',
      `fourth-co-tx-${suffix}`,
      'MYR',
    );

    currentUserId = ownerId;
    await expect(
      createTransaction(
        orgSlug,
        expenseInput({
          kind: 'transfer',
          counterAccountId: other.accountsByCode.bank,
          categoryId: undefined,
        }),
      ),
    ).rejects.toThrow(/does not exist in this company/i);
  });

  it('rejects a category whose kind does not match the transaction kind', async () => {
    currentUserId = ownerId;
    await expect(
      createTransaction(
        orgSlug,
        expenseInput({ kind: 'income', categoryId: rentCategoryId, moneyAccountId: bankAccountId }),
      ),
    ).rejects.toThrow(/category/i);
  });

  it('rejects a zero or negative amount', async () => {
    currentUserId = ownerId;
    await expect(createTransaction(orgSlug, expenseInput({ amount: '0.00' }))).rejects.toThrow();
    await expect(createTransaction(orgSlug, expenseInput({ amount: '-5.00' }))).rejects.toThrow();
  });

  it('leaves nothing behind when the write fails partway', async () => {
    // 分类 kind 不匹配会在写入交易之后、提交之前失败。
    // 整个路径必须在一个事务里，否则会留下没有分录的孤儿交易。
    currentUserId = ownerId;
    const input = expenseInput({ kind: 'income', categoryId: rentCategoryId });

    await expect(createTransaction(orgSlug, input)).rejects.toThrow();

    const rows = await admin`
      select id from transactions
      where organization_id = ${orgId} and client_uuid = ${input.clientUuid}
    `;
    expect(rows).toHaveLength(0);
  });
});
