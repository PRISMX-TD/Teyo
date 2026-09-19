import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '../helpers/db';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '../helpers/test-db';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

let currentUserId = '';
vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: async () => currentUserId,
  requireUserId: async () => currentUserId,
}));

const suffix = randomUUID().slice(0, 8);
const DAY = '2026-09-10';

let ownerId = '';
let org = { id: '', slug: '' };
let moneyAccountId = '';
let expenseCategoryId = '';
let projectId = '';
let otherOrgProjectId = '';

/**
 * transactions.project_id 这一列 0009 就加了，server/repositories/projects.ts
 * 的项目盈亏分析一直在按它聚合——而在这之前**没有任何地方给它写过值**：
 * action 的入参类型里没有这个字段，schema 里也没有。查询侧写对了，写入侧
 * 从来没接上，所以那份报表算出来的恒定是零。
 *
 * 这些用例钉的是接上之后的两件事：值真的落库了，以及别家公司的项目 id
 * 进不来（外键只保证那一行存在，不保证属于哪家公司，而 RLS 不对外键校验
 * 生效——与科目归属是同一类洞）。
 */
beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-project-${suffix}@example.com`, 'Owner');
  org = await createTestOrgWithSeed(ownerId, 'Project Co', `project-co-${suffix}`, 'MYR');
  currentUserId = ownerId;

  const accounts = await admin`
    select id, code from accounts where organization_id = ${org.id} and code in ('bank', 'rent')
  `;
  moneyAccountId = accounts.find((a) => a.code === 'bank')?.id as string;

  const categories = await admin`
    select c.id from categories c
    join accounts a on a.id = c.account_id
    where c.organization_id = ${org.id} and a.code = 'rent'
  `;
  expenseCategoryId = categories[0].id as string;

  const project = await admin`
    insert into projects (organization_id, name, status)
    values (${org.id}, 'Shop Renovation', 'active')
    returning id
  `;
  projectId = project[0].id as string;

  // 另一家公司的项目——用来证明归属校验真的在拦。
  const otherOwnerId = await createTestUser(`test-other-project-${suffix}@example.com`, 'Other');
  const otherOrg = await createTestOrgWithSeed(
    otherOwnerId,
    'Other Co',
    `other-project-co-${suffix}`,
    'MYR',
  );
  const otherProject = await admin`
    insert into projects (organization_id, name, status)
    values (${otherOrg.id}, 'Not Yours', 'active')
    returning id
  `;
  otherOrgProjectId = otherProject[0].id as string;
});

afterAll(async () => {
  await resetTestData();
});

describe('projectId on transactions', () => {
  it('writes project_id when one is supplied', async () => {
    const { createTransaction } = await import('@/server/actions/transactions');
    const clientUuid = randomUUID();

    const result = await createTransaction(org.slug, {
      kind: 'expense',
      occurredOn: DAY,
      amount: '250.00',
      currency: 'MYR',
      moneyAccountId,
      categoryId: expenseCategoryId,
      projectId,
      description: 'Paint and tiles',
      clientUuid,
    });

    const rows = await admin`select project_id from transactions where id = ${result.id}`;
    expect(rows[0].project_id).toBe(projectId);
  });

  it('leaves project_id null when none is supplied', async () => {
    const { createTransaction } = await import('@/server/actions/transactions');

    const result = await createTransaction(org.slug, {
      kind: 'expense',
      occurredOn: DAY,
      amount: '10.00',
      currency: 'MYR',
      moneyAccountId,
      categoryId: expenseCategoryId,
      description: 'No project',
      clientUuid: randomUUID(),
    });

    const rows = await admin`select project_id from transactions where id = ${result.id}`;
    expect(rows[0].project_id).toBeNull();
  });

  it("refuses another company's project", async () => {
    // transactions.project_id -> projects(id) 的外键会放行这个 id（那一行
    // 确实存在），RLS 也不对外键校验生效。挡住它的是 insertTransaction 里的
    // assertProjectBelongsToOrg——与科目归属走同一条规矩。
    const { createTransaction } = await import('@/server/actions/transactions');

    await expect(
      createTransaction(org.slug, {
        kind: 'expense',
        occurredOn: DAY,
        amount: '99.00',
        currency: 'MYR',
        moneyAccountId,
        categoryId: expenseCategoryId,
        projectId: otherOrgProjectId,
        description: 'Cross-tenant attempt',
        clientUuid: randomUUID(),
      }),
    ).rejects.toThrow(/project not found in this company/i);

    // 而且一个字节都没写进去——校验排在任何 insert 之前。
    const rows = await admin`
      select count(*)::int as n from transactions
      where organization_id = ${org.id} and description = 'Cross-tenant attempt'
    `;
    expect(rows[0].n).toBe(0);
  });

  it('refuses a project id that is not a uuid', async () => {
    const { createTransaction } = await import('@/server/actions/transactions');

    await expect(
      createTransaction(org.slug, {
        kind: 'expense',
        occurredOn: DAY,
        amount: '5.00',
        currency: 'MYR',
        moneyAccountId,
        categoryId: expenseCategoryId,
        projectId: 'not-a-uuid',
        description: 'Bad project id',
        clientUuid: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it('keeps the project when an edit does not mention it', async () => {
    // 编辑走的是整体替换（表头覆盖 + 分录全删全插）。若 repostJournal 把
    // 缺省的 projectId 当成 null 写回去，用户每改一次备注就会把项目悄悄清掉。
    const { createTransaction, updateTransaction } = await import('@/server/actions/transactions');

    const created = await createTransaction(org.slug, {
      kind: 'expense',
      occurredOn: DAY,
      amount: '77.00',
      currency: 'MYR',
      moneyAccountId,
      categoryId: expenseCategoryId,
      projectId,
      description: 'Before edit',
      clientUuid: randomUUID(),
    });

    await updateTransaction(org.slug, created.id, {
      occurredOn: DAY,
      amount: '77.00',
      currency: 'MYR',
      moneyAccountId,
      categoryId: expenseCategoryId,
      projectId,
      description: 'After edit',
    });

    const rows = await admin`select project_id, description from transactions where id = ${created.id}`;
    expect(rows[0].description).toBe('After edit');
    expect(rows[0].project_id).toBe(projectId);
  });

  it('clears the project when an edit explicitly drops it', async () => {
    const { createTransaction, updateTransaction } = await import('@/server/actions/transactions');

    const created = await createTransaction(org.slug, {
      kind: 'expense',
      occurredOn: DAY,
      amount: '88.00',
      currency: 'MYR',
      moneyAccountId,
      categoryId: expenseCategoryId,
      projectId,
      description: 'Had a project',
      clientUuid: randomUUID(),
    });

    await updateTransaction(org.slug, created.id, {
      occurredOn: DAY,
      amount: '88.00',
      currency: 'MYR',
      moneyAccountId,
      categoryId: expenseCategoryId,
      description: 'Project removed',
    });

    const rows = await admin`select project_id from transactions where id = ${created.id}`;
    expect(rows[0].project_id).toBeNull();
  });
});
