import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createMoneyAccount, renameAccount, setAccountActive } = await import(
  '@/server/actions/accounts'
);
const { createCategory, createCategoryFromNamedList, renameCategory, setCategoryActive } =
  await import('@/server/actions/categories');

let ownerId: string;
let adminId: string;
let bookkeeperId: string;
let viewerId: string;
let orgId: string;
let orgSlug: string;
let accountsByCode: Record<string, string>;
let categoriesByAccountCode: Record<string, string>;

// 第二家公司，owner 与第一家相同。跨公司测试必须这样搭：换成「别人的公司」
// RLS 就会替应用层挡掉，测试变成假阳性。
let otherOrgId: string;
let otherSlug: string;
let otherAccounts: Record<string, string>;

const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  await resetTestData();

  ownerId = await createTestUser(`owner-set-${suffix}@example.com`, 'Owner');
  adminId = await createTestUser(`admin-set-${suffix}@example.com`, 'Admin');
  bookkeeperId = await createTestUser(`book-set-${suffix}@example.com`, 'Bookkeeper');
  viewerId = await createTestUser(`viewer-set-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'Settings Co', `settings-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  accountsByCode = org.accountsByCode;
  categoriesByAccountCode = org.categoriesByAccountCode;

  await joinOrg(adminId, orgId, 'admin');
  await joinOrg(bookkeeperId, orgId, 'bookkeeper');
  await joinOrg(viewerId, orgId, 'viewer');

  const other = await createTestOrgWithSeed(ownerId, 'Other Set', `other-set-${suffix}`, 'MYR');
  otherOrgId = other.id;
  otherSlug = other.slug;
  otherAccounts = other.accountsByCode;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('createMoneyAccount', () => {
  it('creates an active asset account flagged as a money account', async () => {
    currentUserId = ownerId;
    const { id } = await createMoneyAccount(orgSlug, { nameEn: 'Petty Cash', nameZh: '零用金' });

    const [row] = await admin`
      select organization_id, code, name_en, name_zh, type, is_money_account, is_system, is_active
      from accounts where id = ${id}
    `;
    expect(row.organization_id).toBe(orgId);
    expect(row.code).toBe('petty-cash');
    expect(row.name_en).toBe('Petty Cash');
    expect(row.name_zh).toBe('零用金');
    // 资金账户必须是资产类，accounts_money_is_asset 约束要求。
    expect(row.type).toBe('asset');
    expect(row.is_money_account).toBe(true);
    // 用户建的科目不是系统科目，删改限制与预置科目不同。
    expect(row.is_system).toBe(false);
    expect(row.is_active).toBe(true);
  });

  it('appends a suffix when the derived code is taken', async () => {
    currentUserId = ownerId;
    // seed 里已有 code 为 cash 的现金账户，同名再建一次必须换编码而不是撞唯一约束。
    const { id } = await createMoneyAccount(orgSlug, { nameEn: 'Cash' });

    const [row] = await admin`select code from accounts where id = ${id}`;
    expect(row.code).toBe('cash-2');
  });

  it('falls back to a usable code when the name has no latin characters', async () => {
    currentUserId = ownerId;
    // 纯中文名 slug 化后是空串，必须退回 account 而不是留下空编码。
    const { id } = await createMoneyAccount(orgSlug, { nameZh: '支付宝' });

    const [row] = await admin`select code, name_zh from accounts where id = ${id}`;
    expect(row.code).toMatch(/^account(-\d+)?$/);
    expect(row.name_zh).toBe('支付宝');
  });

  it('rejects a request with no name at all', async () => {
    currentUserId = ownerId;
    await expect(createMoneyAccount(orgSlug, { nameEn: '   ' })).rejects.toThrow();
  });

  it('lets an admin create one', async () => {
    currentUserId = adminId;
    await expect(createMoneyAccount(orgSlug, { nameEn: 'Admin Wallet' })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it('blocks a bookkeeper and a viewer', async () => {
    // AuthError 把 forbidden 放在 code 上，message 是「Your role (...) cannot perform ...」，
    // 所以断言 code；配 /forbidden/i 会永远不匹配。
    currentUserId = bookkeeperId;
    await expect(createMoneyAccount(orgSlug, { nameEn: 'Nope' })).rejects.toMatchObject({
      code: 'forbidden',
    });

    currentUserId = viewerId;
    await expect(createMoneyAccount(orgSlug, { nameEn: 'Nope' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('renameAccount', () => {
  it('changes the names and records the previous values', async () => {
    currentUserId = ownerId;
    const target = accountsByCode.utilities;

    await renameAccount(orgSlug, target, { nameEn: 'Power & Water', nameZh: '水电费' });

    const [row] = await admin`select name_en, name_zh, code from accounts where id = ${target}`;
    expect(row.name_en).toBe('Power & Water');
    expect(row.name_zh).toBe('水电费');
    // 改名不动编码：编码是分录与报表的稳定引用。
    expect(row.code).toBe('utilities');

    const [audit] = await admin`
      select action, before, after from audit_logs
      where entity_id = ${target} and action = 'account.updated'
      order by created_at desc limit 1
    `;
    expect(audit.before).toMatchObject({ nameEn: 'Utilities' });
    expect(audit.after).toMatchObject({ nameEn: 'Power & Water' });
  });

  it('refuses an account from another company the same user owns', async () => {
    currentUserId = ownerId;
    const foreign = otherAccounts.rent;

    await expect(renameAccount(orgSlug, foreign, { nameEn: 'Hijacked' })).rejects.toThrow(
      /not found in this company/i,
    );

    const [row] = await admin`select name_en from accounts where id = ${foreign}`;
    expect(row.name_en).toBe('Rent');
  });
});

describe('setAccountActive', () => {
  it('archives and restores an account', async () => {
    currentUserId = ownerId;
    const target = accountsByCode.marketing;

    await setAccountActive(orgSlug, target, false);
    let [row] = await admin`select is_active from accounts where id = ${target}`;
    expect(row.is_active).toBe(false);

    await setAccountActive(orgSlug, target, true);
    [row] = await admin`select is_active from accounts where id = ${target}`;
    expect(row.is_active).toBe(true);
  });

  it('refuses to archive the last active money account', async () => {
    currentUserId = ownerId;
    const cash = accountsByCode.cash;
    const bank = accountsByCode.bank;

    // 先把这家公司其它资金账户都停掉，只剩 cash 一个启用中的。
    const others = await admin`
      select id from accounts
      where organization_id = ${orgId} and is_money_account and is_active and id <> ${cash}
    `;
    for (const row of others) {
      await setAccountActive(orgSlug, row.id as string, false);
    }

    await expect(setAccountActive(orgSlug, cash, false)).rejects.toThrow(
      /last active money account/i,
    );

    const [still] = await admin`select is_active from accounts where id = ${cash}`;
    expect(still.is_active).toBe(true);

    // 恢复 bank，后面的用例还要能录账。
    await setAccountActive(orgSlug, bank, true);
  });

  it('blocks a viewer', async () => {
    currentUserId = viewerId;
    const target = accountsByCode.transport;

    await expect(setAccountActive(orgSlug, target, false)).rejects.toMatchObject({
      code: 'forbidden',
    });

    const [row] = await admin`select is_active from accounts where id = ${target}`;
    expect(row.is_active).toBe(true);
  });
});

describe('createCategory', () => {
  it('creates an expense category mapped to an expense account', async () => {
    currentUserId = ownerId;
    const { id } = await createCategory(orgSlug, {
      nameEn: 'Software',
      nameZh: '软件',
      kind: 'expense',
      accountId: accountsByCode['other-expenses'],
    });

    const [row] = await admin`
      select organization_id, name_en, kind, account_id, is_active
      from categories where id = ${id}
    `;
    expect(row.organization_id).toBe(orgId);
    expect(row.name_en).toBe('Software');
    expect(row.kind).toBe('expense');
    expect(row.account_id).toBe(accountsByCode['other-expenses']);
    expect(row.is_active).toBe(true);
  });

  it('refuses an income category mapped to an expense account', async () => {
    currentUserId = ownerId;
    // 挂错类型时分录方向仍然平衡，只是科目类型错了，损益表会从此对不上，
    // 所以必须在这一层拦住。
    await expect(
      createCategory(orgSlug, {
        nameEn: 'Wrong',
        kind: 'income',
        accountId: accountsByCode.rent,
      }),
    ).rejects.toThrow(/must map to a revenue account/i);
  });

  it('refuses an account from another company the same user owns', async () => {
    currentUserId = ownerId;
    // categories.account_id 上没有「必须与本公司一致」的约束，
    // 收窄一旦失守就会真的建出一条跨公司引用的分类。
    await expect(
      createCategory(orgSlug, {
        nameEn: 'Leaky',
        kind: 'expense',
        accountId: otherAccounts.rent,
      }),
    ).rejects.toThrow(/not found in this company/i);

    const rows = await admin`
      select id from categories
      where organization_id = ${orgId} and account_id = ${otherAccounts.rent}
    `;
    expect(rows).toHaveLength(0);
  });

  it('blocks a viewer', async () => {
    currentUserId = viewerId;
    await expect(
      createCategory(orgSlug, {
        nameEn: 'Nope',
        kind: 'expense',
        accountId: accountsByCode.rent,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('createCategoryFromNamedList', () => {
  // NamedList 是通用组件，onCreate 的 payload 里 kind/accountId 是可选的；
  // 分类页通过 categoryOptions 收集这两个字段后再传进来。这里测的是那条
  // Server Action 适配层本身，而不是 createCategory 的校验规则（上面已覆盖）。
  it('creates a category when kind and account are both chosen', async () => {
    currentUserId = ownerId;
    const { id } = await createCategoryFromNamedList(orgSlug, {
      nameEn: 'Stock Purchases',
      nameZh: '进货补充',
      kind: 'expense',
      accountId: accountsByCode.purchases,
    });

    const [row] = await admin`
      select organization_id, kind, account_id, is_active
      from categories where id = ${id}
    `;
    expect(row.organization_id).toBe(orgId);
    expect(row.kind).toBe('expense');
    expect(row.account_id).toBe(accountsByCode.purchases);
    expect(row.is_active).toBe(true);
  });

  it('refuses a payload missing kind or account with a readable message, not a raw ZodError', async () => {
    currentUserId = ownerId;
    // 删掉 as unknown as 之前，client 只发 nameEn/nameZh 两个字段，
    // categorySchema.parse 直接抛 ZodError，用户看到的是一坨 JSON。
    // 这里确认收窄失败时给的是一句能看懂的话。
    await expect(
      createCategoryFromNamedList(orgSlug, { nameEn: 'No Kind' }),
    ).rejects.toThrow(/choose income or expense/i);

    await expect(
      createCategoryFromNamedList(orgSlug, { nameEn: 'No Account', kind: 'expense' }),
    ).rejects.toThrow(/choose income or expense/i);
  });

  it('still enforces that an income category maps to a revenue account', async () => {
    currentUserId = ownerId;
    await expect(
      createCategoryFromNamedList(orgSlug, {
        nameEn: 'Wrong',
        kind: 'income',
        accountId: accountsByCode.rent,
      }),
    ).rejects.toThrow(/must map to a revenue account/i);
  });
});

describe('renameCategory', () => {
  it('changes the names without touching the mapped account', async () => {
    currentUserId = ownerId;
    const target = categoriesByAccountCode.transport;

    await renameCategory(orgSlug, target, { nameEn: 'Travel', nameZh: '差旅' });

    const [row] = await admin`select name_en, name_zh, account_id, kind from categories where id = ${target}`;
    expect(row.name_en).toBe('Travel');
    expect(row.name_zh).toBe('差旅');
    expect(row.account_id).toBe(accountsByCode.transport);
    expect(row.kind).toBe('expense');
  });

  it('refuses a category from another company', async () => {
    currentUserId = ownerId;
    const [foreign] = await admin`
      select id, name_en from categories where organization_id = ${otherOrgId} limit 1
    `;

    await expect(
      renameCategory(orgSlug, foreign.id as string, { nameEn: 'Hijacked' }),
    ).rejects.toThrow(/not found in this company/i);

    const [row] = await admin`select name_en from categories where id = ${foreign.id}`;
    expect(row.name_en).toBe(foreign.name_en);
  });
});

describe('setCategoryActive', () => {
  it('archives and restores a category', async () => {
    currentUserId = ownerId;
    const target = categoriesByAccountCode.salaries;

    await setCategoryActive(orgSlug, target, false);
    let [row] = await admin`select is_active from categories where id = ${target}`;
    expect(row.is_active).toBe(false);

    await setCategoryActive(orgSlug, target, true);
    [row] = await admin`select is_active from categories where id = ${target}`;
    expect(row.is_active).toBe(true);
  });

  it('blocks a viewer', async () => {
    currentUserId = viewerId;
    const target = categoriesByAccountCode.rent;

    await expect(setCategoryActive(orgSlug, target, false)).rejects.toMatchObject({
      code: 'forbidden',
    });

    const [row] = await admin`select is_active from categories where id = ${target}`;
    expect(row.is_active).toBe(true);
  });
});
