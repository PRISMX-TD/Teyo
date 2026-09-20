import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import type { OrgContext } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { postJournal } from '@/server/posting/post-journal';
import { getProjectProfitability } from '@/server/repositories/projects';
import {
  createTestOrgWithSeed,
  createTestUser,
  resetTestData,
  seedRate,
  type SeededOrg,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createProject, updateProjectAction, setProjectStatusAction } = await import(
  '@/server/actions/projects'
);

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let org: SeededOrg;
let ctx: OrgContext;

const ON = '2026-03-15';

/**
 * 记一笔手工凭证并挂到某个项目上。
 *
 * project_id 只能用 admin 连接直接写：**全仓没有任何地方给 transactions 写
 * 这一列**。0009 加了它，server/actions/transactions.ts 的入参类型里没有
 * projectId，lib/schemas.ts 里也没有。项目盈亏分析因此是一个实现了一半的
 * 功能——查询这一侧在算，挂载那一侧不存在。这个 helper 的存在本身就是那个
 * 缺口的证据，已在交付报告中列明要在 createTransaction / updateTransaction
 * 与 lib/schemas.ts 里补 projectId。
 */
async function postToProject(args: {
  projectId: string | null;
  debitAccountId: string;
  creditAccountId: string;
  amountMinor: bigint;
  occurredOn?: string;
  currency?: string;
  manualRate?: string;
}): Promise<string> {
  const transactionId = await withTransaction(ownerId, async (tx) => {
    const { transactionId: id } = await postJournal(tx, ctx, {
      event: {
        type: 'journal',
        debitAccountId: args.debitAccountId,
        creditAccountId: args.creditAccountId,
        amountMinor: args.amountMinor,
      },
      occurredOn: args.occurredOn ?? ON,
      description: 'Project entry',
      currency: args.currency ?? 'MYR',
      manualRate: args.manualRate,
      manualRateEntry: 'available',
      categoryId: null,
      clientUuid: randomUUID(),
    });
    return id;
  });

  if (args.projectId) {
    await admin`update transactions set project_id = ${args.projectId} where id = ${transactionId}`;
  }
  return transactionId;
}

function profitability(projectId: string, from?: string, to?: string) {
  return withTransaction(ownerId, (tx) =>
    getProjectProfitability(tx, org.id, projectId, from, to),
  );
}

async function newProject(name: string): Promise<string> {
  currentUserId = ownerId;
  const { id } = await createProject(org.slug, { name });
  return id;
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-proj-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;
  org = await createTestOrgWithSeed(ownerId, 'Project Co', `proj-co-${suffix}`, 'MYR');
  ctx = {
    userId: ownerId,
    organizationId: org.id,
    orgSlug: org.slug,
    role: 'owner',
    baseCurrency: 'MYR',
    lockedUntil: null,
    timezone: 'Asia/Kuala_Lumpur',
  };
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('getProjectProfitability - 口径与 getProfitLoss 对齐', () => {
  it('收入取贷方、费用取借方，只数挂了本项目的交易', async () => {
    const projectId = await newProject('Aligned project');
    const other = await newProject('Someone else');

    // 借现金 / 贷销售收入 —— 收入 500.00
    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 50000n,
    });
    // 借租金 / 贷现金 —— 费用 120.00
    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.rent,
      creditAccountId: org.accountsByCode.cash,
      amountMinor: 12000n,
    });
    // 挂在别的项目上的，不该被数进来
    await postToProject({
      projectId: other,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 99900n,
    });
    // 一笔没挂项目的
    await postToProject({
      projectId: null,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 77700n,
    });

    const result = await profitability(projectId);
    expect(result.projectName).toBe('Aligned project');
    expect(result.totalIncomeMinor).toBe(50000n);
    expect(result.totalExpenseMinor).toBe(12000n);
    expect(result.netProfitMinor).toBe(38000n);
  });

  // 原来只 sum(base_amount_minor)，不分借贷方向。一笔「借销售收入 / 贷应收」
  // 的销售退回（贷项通知单的分录形状，见 posting-templates.ts 的 credit-note）
  // 会被当成**又一笔收入**加上去——退货越多，项目看起来赚得越多。
  it('销售退回冲减收入，而不是被当成又一笔收入', async () => {
    const projectId = await newProject('Returns project');

    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 100000n,
    });
    // 退回 300.00：借销售收入 / 贷现金
    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.sales,
      creditAccountId: org.accountsByCode.cash,
      amountMinor: 30000n,
    });

    const result = await profitability(projectId);
    // 旧写法给 130000（两笔都加）。
    expect(result.totalIncomeMinor).toBe(70000n);
  });

  // 作废是软删除：transactions 行还在、journal_lines 行也还在。
  // getProfitLoss 有 `t.voided_at is null`，这里原来没有——同一笔作废交易
  // 在损益表里没了，在项目盈亏里还在。
  it('作废的交易被排除', async () => {
    const projectId = await newProject('Voided project');

    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 60000n,
    });
    const voided = await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 40000n,
    });
    // transactions_void_fields_together（0001）要求作废三字段同时存在。
    await admin`
      update transactions
      set voided_at = now(), voided_by = ${ownerId}, void_reason = 'test void'
      where id = ${voided}
    `;

    const result = await profitability(projectId);
    expect(result.totalIncomeMinor).toBe(60000n);
  });

  // 闭区间 [from, to]，与 getProfitLoss 的 `>= from and <= to` 相同。
  // 差一天就会出现「项目盈亏加起来不等于损益表」。
  it('日期是闭区间，两端当天都算在内', async () => {
    const projectId = await newProject('Boundary project');

    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 10000n,
      occurredOn: '2026-03-01',
    });
    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 20000n,
      occurredOn: '2026-03-31',
    });
    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 40000n,
      occurredOn: '2026-04-01',
    });

    expect((await profitability(projectId, '2026-03-01', '2026-03-31')).totalIncomeMinor).toBe(
      30000n,
    );
    expect((await profitability(projectId, '2026-03-02', '2026-03-30')).totalIncomeMinor).toBe(0n);
    // 不给区间就是整个生命周期。
    expect((await profitability(projectId)).totalIncomeMinor).toBe(70000n);
  });

  // 取的是 base_amount_minor。外币交易的 amount_minor 是原币，
  // 把 USD 与 MYR 的 amount_minor 相加等于把两种钱当成同一种钱加。
  it('外币交易按本位币金额计入', async () => {
    const projectId = await newProject('Multi currency project');
    await seedRate('USD', 'MYR', 435000000n, ON);

    // USD 100.00，汇率 4.35 -> MYR 435.00
    await postToProject({
      projectId,
      debitAccountId: org.accountsByCode.cash,
      creditAccountId: org.accountsByCode.sales,
      amountMinor: 10000n,
      currency: 'USD',
      manualRate: '4.35',
    });

    const result = await profitability(projectId);
    expect(result.totalIncomeMinor).toBe(43500n);
  });

  // 原来查不到项目就把名字当成空字符串接着算，返回一组零——对「这个项目
  // 不属于本公司」和「这个项目一笔账都没有」给出同一个答案。
  it('不属于本公司的项目 id 当场报错', async () => {
    await expect(profitability(randomUUID())).rejects.toThrow(/Project not found/i);
  });
});

describe('createProject - 预算按本位币的小数位解析', () => {
  // 界面今天传的是 `String(Math.round(parseFloat(budget) * 100))`：硬编码
  // 两位小数 + 浮点。一家本位币为 JPY 的公司会把 150000 日元的预算记成
  // 15,000,000 日元，整整一百倍，账面上没有任何地方看得出来。
  it('JPY 的公司不再被放大一百倍', async () => {
    const jpy = await createTestOrgWithSeed(ownerId, 'Yen Co', `proj-jpy-${suffix}`, 'JPY');

    currentUserId = ownerId;
    const { id } = await createProject(jpy.slug, { name: 'Tokyo build', budget: '150000' });

    const [row] = await admin`select budget_minor from projects where id = ${id}`;
    expect(row.budget_minor).toBe('150000');
  });

  it('MYR 的公司按两位小数解析', async () => {
    currentUserId = ownerId;
    const { id } = await createProject(org.slug, { name: 'KL build', budget: '1200.50' });

    const [row] = await admin`select budget_minor from projects where id = ${id}`;
    expect(row.budget_minor).toBe('120050');
  });

  it('多余的小数位抛错而不是静默截断', async () => {
    currentUserId = ownerId;
    await expect(
      createProject(org.slug, { name: 'Too precise', budget: '100.999' }),
    ).rejects.toThrow(/decimal place/i);
  });

  // 原来是裸 `BigInt(input.budgetMinor)`：'1200.50' 直接抛 SyntaxError，
  // 用户看到的是一句 JS 报错而不是一句能读懂的话。
  it('legacy 的 budgetMinor 仍然收，但必须是整数写法', async () => {
    currentUserId = ownerId;
    const { id } = await createProject(org.slug, { name: 'Legacy minor', budgetMinor: '120050' });
    const [row] = await admin`select budget_minor from projects where id = ${id}`;
    expect(row.budget_minor).toBe('120050');

    await expect(
      createProject(org.slug, { name: 'Legacy broken', budgetMinor: '1200.50' }),
    ).rejects.toThrow();
  });

  it('结束日早于开始日被拒', async () => {
    currentUserId = ownerId;
    await expect(
      createProject(org.slug, {
        name: 'Time traveller',
        startDate: '2026-06-01',
        endDate: '2026-05-01',
      }),
    ).rejects.toThrow(/on or before/i);
  });
});

describe('项目留下审计', () => {
  it('改动记下改之前的样子，状态变更也是', async () => {
    currentUserId = ownerId;
    const { id } = await createProject(org.slug, { name: 'Audited project', budget: '500.00' });

    await updateProjectAction(org.slug, id, { name: 'Audited project v2', budget: '800.00' });
    await setProjectStatusAction(org.slug, id, 'completed');

    const [updated] = await admin`
      select before, after from audit_logs
      where organization_id = ${org.id} and entity_id = ${id} and action = 'project.updated'
    `;
    expect(updated.before).toMatchObject({ name: 'Audited project', budgetMinor: '50000' });
    expect(updated.after).toMatchObject({ name: 'Audited project v2', budgetMinor: '80000' });

    const [status] = await admin`
      select before, after from audit_logs
      where organization_id = ${org.id} and entity_id = ${id}
        and action = 'project.status_changed'
    `;
    expect(status.before).toMatchObject({ status: 'active' });
    expect(status.after).toMatchObject({ status: 'completed' });
  });
});
