// Server Action 入口的入参校验。
//
// 这些 Action 的入参都来自网络：TypeScript 的类型在运行时不存在，
// CreateTransactionInput / RecurringEditFields 挡不住任何一个真实请求。
// 这个文件量的是「接上 zod 之后，非法入参确实进不来，而合法入参一条都没被
// 误伤」。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createTransaction, voidTransaction } = await import('@/server/actions/transactions');
const { createAccount, createMoneyAccount } = await import('@/server/actions/accounts');
const { createRecurring, editRecurring } = await import('@/server/actions/recurring');
const { updateRecurring } = await import('@/server/repositories/recurring');
const { withTransaction } = await import('@/server/db/transaction');

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let orgId: string;
let orgSlug: string;
let cashId: string;
let bankId: string;
let rentCategoryId: string;
let rentAccountId: string;

beforeAll(async () => {
  ownerId = await createTestUser(`test-secval-${suffix}@example.com`, 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Sec Val Co', `sec-val-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  cashId = org.accountsByCode.cash;
  bankId = org.accountsByCode.bank;
  rentAccountId = org.accountsByCode.rent;
  rentCategoryId = org.categoriesByAccountCode.rent;
  currentUserId = ownerId;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

function expense(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'expense' as const,
    occurredOn: '2026-09-10',
    amount: '120.00',
    currency: 'MYR',
    moneyAccountId: cashId,
    categoryId: rentCategoryId,
    description: 'Shop rent',
    clientUuid: randomUUID(),
    ...overrides,
  };
}

describe('createTransaction input validation', () => {
  it('still records an ordinary expense', async () => {
    // 这一条是护栏的护栏：所有正向路径必须原样通过，否则这次改动就是一次
    // 功能回归而不是一次加固。
    const { id, deduplicated } = await createTransaction(orgSlug, expense());
    expect(deduplicated).toBe(false);
    const [row] = await admin`select amount_minor from transactions where id = ${id}`;
    expect(row.amount_minor).toBe('12000');
  });

  it('answers a malformed id with a sentence, not a Postgres error', async () => {
    // 之前这些串一路裸传到 SQL，用户看到的是
    // `invalid input syntax for type uuid: "../../etc/passwd"`。
    for (const bogus of ['../../etc/passwd', "' or 1=1 --", 'undefined', '']) {
      await expect(
        createTransaction(orgSlug, expense({ moneyAccountId: bogus })),
        bogus,
      ).rejects.toThrow(/Pick one of the options in the list\. \(account\)/);
    }
  });

  it('refuses a date that is not YYYY-MM-DD', async () => {
    for (const bogus of ['01/08/2026', '2026-8-1', 'today', '2026-09-10T00:00:00Z']) {
      await expect(
        createTransaction(orgSlug, expense({ occurredOn: bogus })),
        bogus,
      ).rejects.toThrow(/YYYY-MM-DD/);
    }
  });

  it('refuses a transfer that also carries a category', async () => {
    // 转账没有分类（transactions_category_matches_kind 约束），而
    // resolveCounterAccountId 的 transfer 分支根本不看 categoryId，于是这种
    // 入参过去要一路走到数据库才被拒，用户读到的是约束名。
    await expect(
      createTransaction(
        orgSlug,
        expense({ kind: 'transfer', counterAccountId: bankId, categoryId: rentCategoryId }),
      ),
    ).rejects.toThrow(/transfer does not take a category/i);
  });

  it('refuses a transfer into the account it came from', async () => {
    await expect(
      createTransaction(
        orgSlug,
        expense({ kind: 'transfer', counterAccountId: cashId, categoryId: undefined }),
      ),
    ).rejects.toThrow(/two different accounts/i);
  });

  it('accepts a lowercase currency code instead of failing on it', async () => {
    // currencyExponent('myr') 抛 MoneyError('Invalid currency code: myr')。
    // schema 先把币种转成大写，于是这条本来就该成功的记账现在真的成功了。
    const { id } = await createTransaction(orgSlug, expense({ currency: 'myr' }));
    const [row] = await admin`select currency from transactions where id = ${id}`;
    expect(row.currency).toBe('MYR');
  });

  it('caps the note length', async () => {
    await expect(
      createTransaction(orgSlug, expense({ description: 'x'.repeat(501) })),
    ).rejects.toThrow();
  });

  it('leaves nothing behind when validation rejects the request', async () => {
    const clientUuid = randomUUID();
    await expect(
      createTransaction(orgSlug, expense({ clientUuid, amount: '0.00' })),
    ).rejects.toThrow(/greater than zero/i);

    const rows = await admin`
      select id from transactions where organization_id = ${orgId} and client_uuid = ${clientUuid}
    `;
    expect(rows).toHaveLength(0);
  });
});

describe('voidTransaction input validation', () => {
  it('refuses a reason longer than the column keeps', async () => {
    const { id } = await createTransaction(orgSlug, expense());
    await expect(voidTransaction(orgSlug, id, 'x'.repeat(301))).rejects.toThrow(/300/);

    const [row] = await admin`select voided_at from transactions where id = ${id}`;
    expect(row.voided_at).toBeNull();
  });

  it('still refuses a blank reason, with the same words as before', async () => {
    const { id } = await createTransaction(orgSlug, expense());
    await expect(voidTransaction(orgSlug, id, '   ')).rejects.toThrow(/needs a reason/i);
  });
});

describe('account actions now run accountSchema', () => {
  it('refuses an account type that is not one of the five', async () => {
    for (const type of ['Asset', 'contra', '', 'asset; drop table accounts']) {
      await expect(
        createAccount(orgSlug, { nameEn: 'Made up', type: type as never, isMoneyAccount: false }),
        type,
      ).rejects.toThrow(/account type/);
    }
  });

  it('still creates a normal account and a normal money account', async () => {
    const account = await createAccount(orgSlug, {
      nameEn: 'Marketing',
      type: 'expense',
      isMoneyAccount: false,
    });
    const [row] = await admin`select type, is_money_account from accounts where id = ${account.id}`;
    expect(row.type).toBe('expense');
    expect(row.is_money_account).toBe(false);

    const wallet = await createMoneyAccount(orgSlug, { nameZh: '备用金' });
    const [walletRow] = await admin`
      select type, is_money_account from accounts where id = ${wallet.id}
    `;
    expect(walletRow.type).toBe('asset');
    expect(walletRow.is_money_account).toBe(true);
  });

  it('still refuses an account with no name in either language', async () => {
    await expect(
      createAccount(orgSlug, { nameEn: '  ', nameZh: '', type: 'expense', isMoneyAccount: false }),
    ).rejects.toThrow(/name in at least one language/i);
  });
});

describe('editRecurring mass assignment', () => {
  async function newRule(overrides: Record<string, unknown> = {}) {
    const { id } = await createRecurring(orgSlug, {
      kind: 'expense',
      description: 'Monthly rent',
      amount: '1200.00',
      currency: 'MYR',
      debitAccountId: rentAccountId,
      creditAccountId: cashId,
      frequency: 'monthly',
      interval: 1,
      startDate: '2026-09-01',
      ...overrides,
    });
    return id;
  }

  it('refuses to rewrite the catch-up cursor', async () => {
    // 这是这一组里最贵的一条：把 next_due_date 推回很早的日期，下一次
    // generateDueRecurring 就按每期一笔补记，每笔一个新的 clientUuid
    // （幂等拦不住），借贷完全配平（配平触发器也拦不住）。一笔 1200 的
    // 月租能一口气变成几十笔。
    const id = await newRule();

    await expect(
      editRecurring(orgSlug, id, { nextDueDate: '2020-01-01' } as never),
    ).rejects.toThrow();

    const [row] = await admin`select next_due_date from recurring_transactions where id = ${id}`;
    expect(String(row.next_due_date)).toContain('2026');
  });

  it('refuses every other column a payload could name', async () => {
    const id = await newRule();

    for (const payload of [
      { isActive: false },
      { organizationId: randomUUID() },
      { createdAt: '2020-01-01' },
      { next_due_date: '2020-01-01' },
    ]) {
      await expect(
        editRecurring(orgSlug, id, payload as never),
        JSON.stringify(payload),
      ).rejects.toThrow();
    }

    const [row] = await admin`
      select is_active, organization_id from recurring_transactions where id = ${id}
    `;
    expect(row.is_active).toBe(true);
    expect(row.organization_id).toBe(orgId);
  });

  it('still edits the fields the settings form edits', async () => {
    const id = await newRule();

    await editRecurring(orgSlug, id, {
      description: 'Shop rent (renegotiated)',
      amount: '1,350.00',
      currency: 'MYR',
      interval: 3,
    });

    const [row] = await admin`
      select description, amount, "interval" from recurring_transactions where id = ${id}
    `;
    expect(row.description).toBe('Shop rent (renegotiated)');
    // 金额被收敛成规范写法：这一列是 text，不规范化的话同一笔钱会以三种
    // 写法存在库里。
    expect(row.amount).toBe('1350.00');
    expect(Number(row.interval)).toBe(3);
  });

  it('keeps the repository whitelist as a second gate', async () => {
    // 就算有人绕过 Action 直接调仓库函数，未列出的列也写不进去。
    const id = await newRule();

    await withTransaction(ownerId, (tx) =>
      updateRecurring(tx, orgId, id, { isActive: false, createdAt: '2020-01-01' } as never),
    );

    const [row] = await admin`select is_active from recurring_transactions where id = ${id}`;
    expect(row.is_active).toBe(true);
  });
});

describe('recurring_transactions.amount is a text column, so the app carries the checks', () => {
  function rule(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'expense' as const,
      description: 'Rule',
      amount: '1200.00',
      currency: 'MYR',
      debitAccountId: rentAccountId,
      creditAccountId: cashId,
      frequency: 'monthly' as const,
      interval: 1,
      startDate: '2026-09-01',
      ...overrides,
    };
  }

  it('refuses zero and negative amounts that the column would happily store', async () => {
    // amount 是 `text not null`（0008），没有 `> 0` 约束，也不可能有。
    // 一条负金额的规则每期生成一笔方向相反的分录——借贷照样配平。
    for (const amount of ['0.00', '-1200.00', '0']) {
      await expect(createRecurring(orgSlug, rule({ amount })), amount).rejects.toThrow();
    }
    const rows = await admin`
      select id from recurring_transactions
      where organization_id = ${orgId} and (amount like '-%' or amount in ('0', '0.00'))
    `;
    expect(rows).toHaveLength(0);
  });

  it('stores one canonical spelling of the same amount', async () => {
    const { id } = await createRecurring(orgSlug, rule({ amount: '1,200' }));
    const [row] = await admin`select amount from recurring_transactions where id = ${id}`;
    expect(row.amount).toBe('1200.00');
  });

  it('uses the currency exponent instead of a hard-coded 2', async () => {
    // JPY 没有小数。硬写 2 会把合法的「JPY 1200」判成非法，
    // 也会放行一个 JPY 永远不该有的小数部分。
    const { id } = await createRecurring(orgSlug, rule({ amount: '1200', currency: 'JPY' }));
    const [row] = await admin`select amount from recurring_transactions where id = ${id}`;
    expect(row.amount).toBe('1200');

    await expect(
      createRecurring(orgSlug, rule({ amount: '1200.50', currency: 'JPY' })),
    ).rejects.toThrow(/decimal/i);
  });
});
