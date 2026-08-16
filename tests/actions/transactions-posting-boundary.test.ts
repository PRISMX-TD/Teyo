import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  resetTestData,
  seedRate,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createJournal, createTransaction, updateTransaction } = await import(
  '@/server/actions/transactions'
);

let ownerId: string;
let orgId: string;
let orgSlug: string;
let cashId: string;
let bankId: string;
let suspenseId: string;
let rentCategoryId: string;
let utilitiesCategoryId: string;

// slug 全局唯一，固定值会让上一轮的残留数据卡死后续所有测试。
const suffix = randomUUID().slice(0, 8);

// exchange_rates 没有公司维度隔离，是全局共享表。GBP 在别的测试文件里
// 一次都没出现过（其余文件用 SGD / USD / EUR），并行跑不会互相抹掉。
const RATE_DAY = '2031-05-10';
const JOURNAL_RATE_DAY = '2031-07-25';
// findRate 有 7 天回溯，这一天必须离上面两天都足够远，否则「查不到汇率」
// 会被回溯悄悄救活，测试就量不到该量的东西了。
const NO_RATE_DAY = '2031-09-15';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-boundary-${suffix}@example.com`, 'Owner');

  const org = await createTestOrgWithSeed(ownerId, 'Boundary Co', `boundary-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  cashId = org.accountsByCode.cash;
  bankId = org.accountsByCode.bank;
  suspenseId = org.accountsByCode.suspense;
  rentCategoryId = org.categoriesByAccountCode.rent;
  utilitiesCategoryId = org.categoriesByAccountCode.utilities;
});

afterAll(async () => {
  await admin`update organizations set locked_until = null where id = ${orgId}`;
  await resetTestData();
  await admin.end();
});

async function newExpense(overrides: Record<string, unknown> = {}) {
  currentUserId = ownerId;
  const { id } = await createTransaction(orgSlug, {
    kind: 'expense',
    occurredOn: '2026-10-05',
    amount: '300.00',
    currency: 'MYR',
    moneyAccountId: cashId,
    categoryId: rentCategoryId,
    description: 'Original note',
    clientUuid: randomUUID(),
    ...overrides,
  });
  return id;
}

async function linesFor(transactionId: string) {
  return admin`
    select a.code, l.direction, l.amount_minor
    from journal_lines l join accounts a on a.id = l.account_id
    where l.transaction_id = ${transactionId}
    order by l.direction
  `;
}

describe('updateTransaction - an edit is never mistaken for a replay', () => {
  // The trap this pins down: the row being edited already carries its own
  // client_uuid. Routing an edit through the create path's clientUuid
  // idempotency lookup would hit that very row, return "already posted" and
  // write nothing at all -- the save would appear to succeed and silently
  // do nothing. repostJournal has no such lookup; this test is what stops
  // one being reintroduced.
  it('writes the edit even though the row already carries the same client uuid', async () => {
    const clientUuid = randomUUID();
    const id = await newExpense({ clientUuid });

    currentUserId = ownerId;
    await updateTransaction(orgSlug, id, {
      occurredOn: '2026-10-06',
      amount: '777.00',
      currency: 'MYR',
      moneyAccountId: bankId,
      categoryId: utilitiesCategoryId,
      description: 'Actually updated',
    });

    const [row] = await admin`
      select amount_minor, base_amount_minor, description, client_uuid
      from transactions where id = ${id}
    `;
    expect(row.amount_minor).toBe('77700');
    expect(row.base_amount_minor).toBe('77700');
    expect(row.description).toBe('Actually updated');
    // 幂等键本身不能被编辑改掉，否则离线队列的重放会变成第二笔账。
    expect(row.client_uuid).toBe(clientUuid);

    expect(await linesFor(id)).toEqual([
      { code: 'utilities', direction: 'debit', amount_minor: '77700' },
      { code: 'bank', direction: 'credit', amount_minor: '77700' },
    ]);

    // 编辑就是编辑：这个 clientUuid 底下始终只有一行。
    const rows = await admin`
      select id from transactions
      where organization_id = ${orgId} and client_uuid = ${clientUuid}
    `;
    expect(rows).toHaveLength(1);
  });

  it('writes an updated audit entry, not a second created one', async () => {
    const id = await newExpense();

    currentUserId = ownerId;
    await updateTransaction(orgSlug, id, {
      occurredOn: '2026-10-05',
      amount: '450.00',
      currency: 'MYR',
      moneyAccountId: cashId,
      categoryId: rentCategoryId,
      description: 'Amended',
    });

    const created = await admin`
      select id from audit_logs where entity_id = ${id} and action = 'transaction.created'
    `;
    expect(created).toHaveLength(1);

    const updated = await admin`
      select before, after from audit_logs
      where entity_id = ${id} and action = 'transaction.updated'
    `;
    expect(updated).toHaveLength(1);
    expect(updated[0].before).toMatchObject({ amountMinor: '30000', description: 'Original note' });
    expect(updated[0].after).toMatchObject({ amountMinor: '45000', description: 'Amended' });
  });
});

describe('updateTransaction - a transfer keeps its direction through a rebuild', () => {
  // The transfer pair is counter-intuitive and the migration is exactly where
  // it could get flipped: the form labels moneyAccountId the *destination*
  // (transaction.destinationAccount) and counterAccountId the *source*
  // (transaction.sourceAccount), so the money account is debited and the
  // counter account credited. createTransaction's suite pins the create path;
  // nothing pinned the edit path, which rebuilds the lines from scratch.
  it('debits the money account and credits the counter account after an edit', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(orgSlug, {
      kind: 'transfer',
      occurredOn: '2026-10-08',
      amount: '800.00',
      currency: 'MYR',
      moneyAccountId: bankId, // destination
      counterAccountId: cashId, // source
      description: 'Cash banked',
      clientUuid: randomUUID(),
    });

    expect(await linesFor(id)).toEqual([
      { code: 'bank', direction: 'debit', amount_minor: '80000' },
      { code: 'cash', direction: 'credit', amount_minor: '80000' },
    ]);

    await updateTransaction(orgSlug, id, {
      occurredOn: '2026-10-09',
      amount: '850.00',
      currency: 'MYR',
      moneyAccountId: bankId,
      counterAccountId: cashId,
      description: 'Cash banked, corrected',
    });

    expect(await linesFor(id)).toEqual([
      { code: 'bank', direction: 'debit', amount_minor: '85000' },
      { code: 'cash', direction: 'credit', amount_minor: '85000' },
    ]);

    // 转账不挂分类，与 transactions_category_matches_kind 一致。
    const [row] = await admin`select category_id from transactions where id = ${id}`;
    expect(row.category_id).toBeNull();
  });

  it('rejects an edit that would move money between one and the same account', async () => {
    currentUserId = ownerId;
    const { id } = await createTransaction(orgSlug, {
      kind: 'transfer',
      occurredOn: '2026-10-08',
      amount: '100.00',
      currency: 'MYR',
      moneyAccountId: bankId,
      counterAccountId: cashId,
      description: 'Cash banked',
      clientUuid: randomUUID(),
    });

    await expect(
      updateTransaction(orgSlug, id, {
        occurredOn: '2026-10-08',
        amount: '100.00',
        currency: 'MYR',
        moneyAccountId: bankId,
        counterAccountId: bankId,
        description: 'Same account both sides',
      }),
    ).rejects.toThrow(/different accounts/i);

    expect(await linesFor(id)).toEqual([
      { code: 'bank', direction: 'debit', amount_minor: '10000' },
      { code: 'cash', direction: 'credit', amount_minor: '10000' },
    ]);
  });
});

describe('updateTransaction - the stored-rate rule lives inside the boundary', () => {
  // Phase 1B's fix, re-pinned after the rule moved into repostJournal: the
  // decision is made from the row being edited, not from anything the caller
  // computes and hands in. The existing suite covers a description-only edit;
  // this one changes the amount and the money account, so it also proves the
  // reused rate is applied to the *new* amount rather than the old base
  // figure simply being left alone.
  it('reuses the stored rate for an amount change on an unchanged currency and date', async () => {
    await seedRate('GBP', 'MYR', 5_00000000n, RATE_DAY);

    currentUserId = ownerId;
    const { id } = await createTransaction(orgSlug, {
      kind: 'expense',
      occurredOn: RATE_DAY,
      amount: '100.00',
      currency: 'GBP',
      moneyAccountId: cashId,
      categoryId: rentCategoryId,
      description: 'Foreign original',
      clientUuid: randomUUID(),
    });

    const [before] = await admin`
      select exchange_rate, base_amount_minor from transactions where id = ${id}
    `;
    expect(Number(before.exchange_rate)).toBeCloseTo(5.0, 6);
    expect(before.base_amount_minor).toBe('50000');

    // cron 在同一天晚些时候把这一格改掉。编辑不改币种也不改日期，
    // 就不该看到这个新值。
    await seedRate('GBP', 'MYR', 6_00000000n, RATE_DAY);

    await updateTransaction(orgSlug, id, {
      occurredOn: RATE_DAY,
      amount: '200.00',
      currency: 'GBP',
      moneyAccountId: bankId,
      categoryId: utilitiesCategoryId,
      description: 'Invoice was for twice that',
    });

    const [after] = await admin`
      select exchange_rate, amount_minor, base_amount_minor, rate_source
      from transactions where id = ${id}
    `;
    expect(Number(after.exchange_rate)).toBeCloseTo(5.0, 6);
    expect(after.amount_minor).toBe('20000');
    // 沿用的是汇率，不是当初那个本位币金额——新金额按 5.0 重算。
    expect(after.base_amount_minor).toBe('100000');
    expect(after.rate_source).toBe('auto');

    const lines = await admin`
      select a.code, l.direction, l.amount_minor, l.base_amount_minor
      from journal_lines l join accounts a on a.id = l.account_id
      where l.transaction_id = ${id} order by l.direction
    `;
    expect(lines).toEqual([
      { code: 'utilities', direction: 'debit', amount_minor: '20000', base_amount_minor: '100000' },
      { code: 'bank', direction: 'credit', amount_minor: '20000', base_amount_minor: '100000' },
    ]);
  });
});

describe('updateTransaction - both dates are checked against the lock', () => {
  it('rejects an edit whose old date is locked even though the new date is open, and leaves the lines intact', async () => {
    const id = await newExpense({ occurredOn: '2026-10-15' });
    await admin`update organizations set locked_until = '2026-10-31' where id = ${orgId}`;

    currentUserId = ownerId;
    await expect(
      updateTransaction(orgSlug, id, {
        occurredOn: '2026-11-05', // 开放期
        amount: '999.00',
        currency: 'MYR',
        moneyAccountId: bankId,
        categoryId: utilitiesCategoryId,
        description: 'Sneaking it out of the locked period',
      }),
    ).rejects.toThrow(/locked/i);

    await admin`update organizations set locked_until = null where id = ${orgId}`;

    const [row] = await admin`
      select occurred_on, amount_minor, description from transactions where id = ${id}
    `;
    expect(row.amount_minor).toBe('30000');
    expect(row.description).toBe('Original note');

    // 分录是先删后插的：期间检查若排在删除之后，被拒绝的编辑就得靠事务回滚
    // 才不会留下一条没有分录的交易。这里直接量最终状态。
    expect(await linesFor(id)).toEqual([
      { code: 'rent', direction: 'debit', amount_minor: '30000' },
      { code: 'cash', direction: 'credit', amount_minor: '30000' },
    ]);
  });
});

describe('createJournal - a foreign-currency voucher needs a real rate', () => {
  // Before the migration createJournal hardcoded scaledRate = RATE_SCALE and
  // rateSource = 'auto' while still accepting an optional currency, so a
  // voucher in a foreign currency was posted at a fabricated 1:1 rate and
  // nothing in the stored row said so. Routed through postJournal it now goes
  // to resolveRate like every other write: a real cached rate, a manual one,
  // or an error -- never an invented 1.
  //
  // Both UI callers (journal-form.tsx and transaction-form.tsx's not-sure
  // branch) pass currency: baseCurrency, so no existing screen can reach this
  // branch; it is reachable from the offline queue replaying a payload whose
  // baseCurrency has since changed, and from any future caller.
  it('refuses a foreign-currency voucher when no rate is cached, and writes nothing', async () => {
    currentUserId = ownerId;
    const clientUuid = randomUUID();

    await expect(
      createJournal(orgSlug, {
        occurredOn: NO_RATE_DAY,
        amount: '150.00',
        currency: 'GBP',
        debitAccountId: cashId,
        creditAccountId: suspenseId,
        description: 'Foreign voucher, no rate anywhere',
        clientUuid,
      }),
    ).rejects.toThrow(/rate/i);

    const rows = await admin`
      select id from transactions
      where organization_id = ${orgId} and client_uuid = ${clientUuid}
    `;
    expect(rows).toHaveLength(0);
  });

  it('posts a foreign-currency voucher at the cached rate once one exists', async () => {
    await seedRate('GBP', 'MYR', 5_50000000n, JOURNAL_RATE_DAY);

    currentUserId = ownerId;
    const { id } = await createJournal(orgSlug, {
      occurredOn: JOURNAL_RATE_DAY,
      amount: '100.00',
      currency: 'GBP',
      debitAccountId: cashId,
      creditAccountId: suspenseId,
      description: 'Foreign voucher at a real rate',
      clientUuid: randomUUID(),
    });

    const [row] = await admin`
      select currency, amount_minor, base_amount_minor, exchange_rate, rate_source
      from transactions where id = ${id}
    `;
    expect(row.currency).toBe('GBP');
    expect(row.amount_minor).toBe('10000');
    expect(row.base_amount_minor).toBe('55000');
    expect(Number(row.exchange_rate)).toBeCloseTo(5.5, 6);
    expect(row.rate_source).toBe('auto');
  });

  it('still posts a base-currency voucher at exactly 1 without consulting the rate cache', async () => {
    currentUserId = ownerId;
    const { id } = await createJournal(orgSlug, {
      occurredOn: NO_RATE_DAY,
      amount: '150.00',
      currency: 'MYR',
      debitAccountId: cashId,
      creditAccountId: suspenseId,
      description: 'Domestic voucher',
      clientUuid: randomUUID(),
    });

    const [row] = await admin`
      select amount_minor, base_amount_minor, exchange_rate, rate_source
      from transactions where id = ${id}
    `;
    expect(row.amount_minor).toBe('15000');
    expect(row.base_amount_minor).toBe('15000');
    expect(Number(row.exchange_rate)).toBe(1);
    expect(row.rate_source).toBe('auto');
  });
});
