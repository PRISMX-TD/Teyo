// 跨公司隔离（代码层 IDOR）。
//
// 两家公司的 owner 是同一个人——这是关键：RLS 对这种情况完全放行，因为
// 请求者确实是两边的成员。而这个应用里谁都能再建一家公司，所以「同时属于
// 两家公司」是常态，不是边角情况。挡住它的只能是应用层那句
// `and organization_id = ${context.organizationId}`。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from '@/server/repositories/bank_import';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createTransaction } = await import('@/server/actions/transactions');
const { reconcile, updateItem, complete } = await import('@/server/actions/reconciliation');
const { uploadBankStatement, matchTransaction } = await import('@/server/actions/bank_import');
const { getInvitationPreview } = await import('@/server/actions/profile');

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let orgA: { id: string; slug: string; cash: string; rentCategory: string };
let orgB: { id: string; slug: string; cash: string; rentCategory: string };

beforeAll(async () => {
  ownerId = await createTestUser(`test-sectenant-${suffix}@example.com`, 'Owner of both');

  const a = await createTestOrgWithSeed(ownerId, 'Tenant A', `sec-tenant-a-${suffix}`, 'MYR');
  const b = await createTestOrgWithSeed(ownerId, 'Tenant B', `sec-tenant-b-${suffix}`, 'MYR');

  orgA = {
    id: a.id,
    slug: a.slug,
    cash: a.accountsByCode.cash,
    rentCategory: a.categoriesByAccountCode.rent,
  };
  orgB = {
    id: b.id,
    slug: b.slug,
    cash: b.accountsByCode.cash,
    rentCategory: b.categoriesByAccountCode.rent,
  };

  currentUserId = ownerId;
});

afterAll(async () => {
  // 先手工清掉对账与导入的行，再交给 resetTestData 删公司。
  //
  // reconciliation_items.transaction_id 与 imported_transactions
  // .matched_transaction_id 这两条外键在生产库上还是 NO ACTION——
  // 0020_transaction_fk_cascade.sql 正是为它们写的，但尚未应用。删公司时，
  // transactions 与这些子表各自沿自己的路径级联删除，而 NO ACTION 的引用
  // 完整性检查若排在子表那条级联之前跑，整句 delete 就会被顶回来：
  //   update or delete on table "transactions" violates foreign key
  //   constraint "reconciliation_items_transaction_id_fkey"
  // 那正是 0020 头部描述的症状，这里只是本用例自己把路让开。
  const ids = [orgA.id, orgB.id];
  await admin`
    delete from reconciliation_items
    where reconciliation_id in (
      select id from bank_reconciliations where organization_id = any(${ids})
    )
  `;
  await admin`delete from bank_reconciliations where organization_id = any(${ids})`;
  await admin`delete from imported_transactions where organization_id = any(${ids})`;

  await resetTestData();
  await admin.end();
});

async function newTransaction(org: typeof orgA): Promise<string> {
  const { id } = await createTransaction(org.slug, {
    kind: 'expense',
    occurredOn: '2026-09-15',
    amount: '250.00',
    currency: 'MYR',
    moneyAccountId: org.cash,
    categoryId: org.rentCategory,
    description: 'Rent',
    clientUuid: randomUUID(),
  });
  return id;
}

describe('reconciliation is bound to one company', () => {
  it('refuses to reconcile against another company bank account', async () => {
    await expect(
      reconcile(orgA.slug, {
        moneyAccountId: orgB.cash,
        statementDate: '2026-09-30',
        statementBalance: '1000.00',
        itemIds: [],
        adjustments: {},
      }),
    ).rejects.toThrow(/does not exist in this company/i);

    const rows = await admin`
      select id from bank_reconciliations where money_account_id = ${orgB.cash}
    `;
    expect(rows).toHaveLength(0);
  });

  it('refuses to pull another company transactions into the statement', async () => {
    // reconciliation_items.transaction_id 的外键只指向 transactions(id)，
    // 没有公司维度——不查一次的话，别家公司的交易会出现在本公司的对账
    // 清单上并影响清帐差额。
    const foreign = await newTransaction(orgB);

    await expect(
      reconcile(orgA.slug, {
        moneyAccountId: orgA.cash,
        statementDate: '2026-09-30',
        statementBalance: '1000.00',
        itemIds: [foreign],
        adjustments: {},
      }),
    ).rejects.toThrow(/not in this company/i);

    const rows = await admin`
      select id from reconciliation_items where transaction_id = ${foreign}
    `;
    expect(rows).toHaveLength(0);
  });

  it('reconciles normally inside one company', async () => {
    const own = await newTransaction(orgA);
    const { id } = await reconcile(orgA.slug, {
      moneyAccountId: orgA.cash,
      statementDate: '2026-09-30',
      statementBalance: '1000.00',
      itemIds: [own],
      // 界面把每一个输入框的当前值都放进这张表，包括空的那些。
      adjustments: { [own]: '', [randomUUID()]: '' },
    });

    const [row] = await admin`
      select organization_id, reconciled_at from bank_reconciliations where id = ${id}
    `;
    expect(row.organization_id).toBe(orgA.id);
    expect(row.reconciled_at).not.toBeNull();
  });

  describe('with a reconciliation that belongs to company B', () => {
    let reconciliationB: string;
    let itemB: string;

    beforeAll(async () => {
      const own = await newTransaction(orgB);
      const { id } = await reconcile(orgB.slug, {
        moneyAccountId: orgB.cash,
        statementDate: '2026-09-30',
        statementBalance: '900.00',
        itemIds: [own],
        adjustments: {},
      });
      reconciliationB = id;
      const [item] = await admin`
        select id from reconciliation_items where reconciliation_id = ${id}
      `;
      itemB = item.id as string;
    });

    it('refuses to tick a line on it from company A', async () => {
      // updateReconciliationItem 的 where 以前只有 id：一个 uuid 就够改别人
      // 公司的对账行。reconciliation_items 表上根本没有 organization_id 列，
      // 公司维度只在父表上，所以修法是 join 上去过滤，不是加一个列。
      await expect(updateItem(orgA.slug, itemB, false, '99.00')).rejects.toThrow(
        /not found in this company/i,
      );

      const [row] = await admin`
        select is_cleared, adjustment_minor from reconciliation_items where id = ${itemB}
      `;
      expect(row.is_cleared).toBe(true);
      expect(row.adjustment_minor).toBe('0');
    });

    it('refuses to close it from company A', async () => {
      await admin`update bank_reconciliations set reconciled_at = null where id = ${reconciliationB}`;

      await expect(complete(orgA.slug, reconciliationB)).rejects.toThrow(
        /not found in this company/i,
      );

      const [row] = await admin`
        select reconciled_at from bank_reconciliations where id = ${reconciliationB}
      `;
      expect(row.reconciled_at).toBeNull();
    });

    it('still lets company B tick its own line', async () => {
      await updateItem(orgB.slug, itemB, false, '12.50');
      const [row] = await admin`
        select is_cleared, adjustment_minor from reconciliation_items where id = ${itemB}
      `;
      expect(row.is_cleared).toBe(false);
      expect(row.adjustment_minor).toBe('1250');
    });
  });
});

describe('bank import', () => {
  function statement(rows: string[]): FormData {
    const form = new FormData();
    form.set(
      'file',
      new File([['Date,Description,Amount', ...rows].join('\n')], 'statement.csv', {
        type: 'text/csv',
      }),
    );
    form.set('moneyAccountId', orgA.cash);
    return form;
  }

  it('imports a normal statement, to the cent', async () => {
    // 金额里带千分位逗号，所以这一格必须加引号——这正是银行导出的样子。
    const form = statement(['2026-09-01,Rent,"RM-1,200.50"', '2026-09-02,Sales,RM900.00']);
    const { count } = await uploadBankStatement(orgA.slug, form);
    expect(count).toBe(2);

    const rows = await admin`
      select amount_minor from imported_transactions
      where organization_id = ${orgA.id} order by transaction_date
    `;
    // 'RM-1,200.50' 过去被 parseFloat 读成 NaN 再变成 0——一笔编出来的零。
    expect(rows.map((r) => r.amount_minor)).toEqual(['-120050', '90000']);
  });

  it('refuses a bank account that belongs to another company', async () => {
    // imported_transactions.money_account_id 的外键没有公司维度，所以这
    // 一整份对账单本来是可以挂到别人的银行账户底下的。之前这里只检查了
    // `typeof moneyAccountId === 'string'`。
    const form = statement(['2026-09-01,Rent,-100.00']);
    form.set('moneyAccountId', orgB.cash);

    await expect(uploadBankStatement(orgA.slug, form)).rejects.toThrow(
      /does not exist in this company/i,
    );

    const rows = await admin`
      select id from imported_transactions where money_account_id = ${orgB.cash}
    `;
    expect(rows).toHaveLength(0);
  });

  it('refuses an id that is not even a uuid', async () => {
    const form = statement(['2026-09-01,Rent,-100.00']);
    form.set('moneyAccountId', 'not-a-uuid');
    await expect(uploadBankStatement(orgA.slug, form)).rejects.toThrow(/Pick the bank account/i);
  });

  it('refuses a file bigger than the limit before reading it', async () => {
    const form = new FormData();
    form.set('file', new File(['x'.repeat(MAX_IMPORT_BYTES + 1)], 'huge.csv', { type: 'text/csv' }));
    form.set('moneyAccountId', orgA.cash);

    await expect(uploadBankStatement(orgA.slug, form)).rejects.toThrow(/under 4MB/i);
  });

  it('refuses more rows than one transaction should carry', async () => {
    // 生产连接池只有 3 条连接。几十万行挤进一个事务会占死一条，
    // 三份这样的文件同时上传就把整个应用卡住了。
    const rows = Array.from(
      { length: MAX_IMPORT_ROWS + 1 },
      (_, i) => `2026-09-01,Row ${i},1.00`,
    );
    await expect(uploadBankStatement(orgA.slug, statement(rows))).rejects.toThrow(
      new RegExp(`up to ${MAX_IMPORT_ROWS}`),
    );

    const [count] = await admin`
      select count(*)::int as n from imported_transactions where organization_id = ${orgA.id}
    `;
    expect(Number(count.n)).toBe(2); // 只有第一条用例导入的那两笔
  });

  it('refuses the whole file rather than recording one row as zero', async () => {
    await expect(
      uploadBankStatement(
        orgA.slug,
        statement(['2026-09-01,Rent,-100.00', '2026-09-02,Sales,see attached']),
      ),
    ).rejects.toThrow(/Line 3/);

    const [count] = await admin`
      select count(*)::int as n from imported_transactions where organization_id = ${orgA.id}
    `;
    expect(Number(count.n)).toBe(2);
  });

  it('refuses to match an imported row to another company transaction', async () => {
    const [imported] = await admin`
      select id from imported_transactions where organization_id = ${orgA.id} limit 1
    `;
    const foreign = await newTransaction(orgB);

    await expect(
      matchTransaction(orgA.slug, imported.id as string, foreign),
    ).rejects.toThrow(/not found in this company/i);

    const [row] = await admin`
      select matched_transaction_id, status from imported_transactions where id = ${imported.id}
    `;
    expect(row.matched_transaction_id).toBeNull();
    expect(row.status).toBe('pending');
  });

  it('still matches a row to a transaction of its own company', async () => {
    const [imported] = await admin`
      select id from imported_transactions where organization_id = ${orgA.id} limit 1
    `;
    const own = await newTransaction(orgA);

    await matchTransaction(orgA.slug, imported.id as string, own);

    const [row] = await admin`
      select matched_transaction_id, status from imported_transactions where id = ${imported.id}
    `;
    expect(row.matched_transaction_id).toBe(own);
    expect(row.status).toBe('matched');
  });
});

describe('getInvitationPreview is no longer an unauthenticated endpoint', () => {
  it('refuses an anonymous caller', async () => {
    // 这是个 'use server' 导出，也就是任何人都能 POST 的端点，而它内部走
    // withoutUserContext——以 postgres 身份执行，绕开全部 RLS。在此之前
    // 谁都能拿 token 的哈希去换公司名称与角色。
    currentUserId = null;
    await expect(getInvitationPreview('anything')).rejects.toThrow();
    currentUserId = ownerId;
  });

  it('costs a signed-in caller nothing', async () => {
    // 唯一的调用方 app/(auth)/invite/[token]/page.tsx 本来就先调了
    // requireUserId()，所以这一道检查是白加的。
    currentUserId = ownerId;
    await expect(getInvitationPreview('not-a-real-token')).resolves.toMatchObject({
      state: 'invalid',
    });
  });
});
