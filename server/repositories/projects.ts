import type { Tx } from '@/server/db/transaction';
import { toIsoDate } from '@/lib/format';

export type ProjectRow = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  contactId: string | null;
  contactName: string | null;
  status: 'active' | 'completed' | 'cancelled';
  budgetMinor: bigint | null;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  createdAt: string;
};

export async function listProjects(tx: Tx, organizationId: string): Promise<ProjectRow[]> {
  const rows = await tx`
    select p.id, p.organization_id, p.name, p.description, p.contact_id,
           p.status, p.budget_minor, p.start_date, p.end_date,
           p.is_active, p.created_at,
           c.name as contact_name
    from projects p
    left join contacts c on c.id = p.contact_id
    where p.organization_id = ${organizationId}
    order by p.name
  `;
  return rows.map(mapProject);
}

export async function getProject(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<ProjectRow | null> {
  const rows = await tx`
    select p.id, p.organization_id, p.name, p.description, p.contact_id,
           p.status, p.budget_minor, p.start_date, p.end_date,
           p.is_active, p.created_at,
           c.name as contact_name
    from projects p
    left join contacts c on c.id = p.contact_id
    where p.id = ${id} and p.organization_id = ${organizationId}
  `;
  return rows.length ? mapProject(rows[0]) : null;
}

export async function insertProject(
  tx: Tx,
  row: {
    organizationId: string;
    name: string;
    description?: string;
    contactId?: string;
    budgetMinor?: bigint;
    startDate?: string;
    endDate?: string;
  },
): Promise<{ id: string }> {
  const r = await tx`
    insert into projects (
      organization_id, name, description, contact_id, budget_minor,
      start_date, end_date
    )
    values (
      ${row.organizationId}, ${row.name},
      ${row.description ?? null}, ${row.contactId ?? null},
      ${row.budgetMinor?.toString() ?? null},
      ${row.startDate ?? null}, ${row.endDate ?? null}
    )
    returning id
  `;
  return { id: r[0].id as string };
}

export async function updateProject(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: Partial<{
    name: string;
    description: string;
    contactId: string;
    budgetMinor: bigint;
    startDate: string;
    endDate: string;
  }>,
): Promise<void> {
  await tx`
    update projects set
      name = coalesce(${fields.name ?? null}, name),
      description = ${fields.description ?? null},
      contact_id = ${fields.contactId ?? null},
      budget_minor = ${fields.budgetMinor?.toString() ?? null},
      start_date = ${fields.startDate ?? null},
      end_date = ${fields.endDate ?? null}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function setProjectStatus(
  tx: Tx,
  organizationId: string,
  id: string,
  status: 'active' | 'completed' | 'cancelled',
): Promise<void> {
  await tx`
    update projects
    set status = ${status}::project_status
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export type ProjectProfitability = {
  projectId: string;
  projectName: string;
  totalIncomeMinor: bigint;
  totalExpenseMinor: bigint;
  netProfitMinor: bigint;
};

/**
 * 汇总挂在某个项目下的收入与费用。
 *
 * 口径与 server/repositories/reports.ts 的 getProfitLoss 逐条对齐——两张页面
 * 同时展示同一批交易，口径差一条就会出现「项目盈亏加起来不等于损益表」这种
 * 没人能查的问题：
 *
 *   - 金额取 base_amount_minor（本位币）。外币交易的 amount_minor 是原币，
 *     把它们相加等于把不同的钱当成同一种钱加。
 *   - 排除作废交易（t.voided_at is null）。**这一条原来漏了**：一笔作废的
 *     收入仍然算在项目收入里，而它在损益表里已经不见了。作废是软删除，
 *     transactions 行还在、journal_lines 行也还在，只有这个 where 条件能把
 *     它们挡住。
 *   - 日期闭区间 [from, to]，与 getProfitLoss 的 `>= from and <= to` 相同。
 *   - 收入取「贷 - 借」、费用取「借 - 贷」，与 getProfitLoss 对同一科目类型的
 *     处理一致。原来只 sum(base_amount_minor)，不分借贷方向——于是一笔
 *     「借销售收入 / 贷应收」的销售退回（贷项通知单的分录形状，见
 *     posting-templates.ts 的 credit-note）会被当成**又一笔收入**加上去，
 *     退货越多，项目看起来赚得越多。
 *
 * 两条查询合并成一条：原来收入与费用各查一次，同一组 join 跑两遍，而它们
 * 唯一的差别是 a.type。
 *
 * ⚠️ 这个函数今天算得出数，但永远是 0：**没有任何地方给 transactions 写
 * project_id**。0009 加了这一列，server/actions/transactions.ts 的入参类型里
 * 没有 projectId，lib/schemas.ts 里也没有，全仓 `grep project_id` 只命中本
 * 文件。也就是说项目盈亏分析是一个实现了一半的功能：查询这一侧是对的（现在
 * 更对了），挂载那一侧根本不存在。已在交付报告中列明需要在 createTransaction /
 * updateTransaction 的入参与 lib/schemas.ts 里补 projectId——那两个文件不在
 * 本次改动范围内。
 */
export async function getProjectProfitability(
  tx: Tx,
  organizationId: string,
  projectId: string,
  from?: string,
  to?: string,
): Promise<ProjectProfitability> {
  const projectRows = await tx`
    select name from projects
    where id = ${projectId} and organization_id = ${organizationId}
  `;
  const project = projectRows.at(0);
  // 原来查不到就把名字当成空字符串接着往下算，返回一组零。那等于对
  // 「这个项目不属于本公司」和「这个项目一笔账都没有」给出同一个答案，
  // 而前者是调用方传错了 id，后者是正常状态。
  if (!project) throw new Error('Project not found.');

  const rows = await tx`
    select
      a.type,
      coalesce(sum(case when jl.direction = 'debit' then jl.base_amount_minor else 0 end), 0) as debit,
      coalesce(sum(case when jl.direction = 'credit' then jl.base_amount_minor else 0 end), 0) as credit
    from journal_lines jl
    join transactions t on t.id = jl.transaction_id
    join accounts a on a.id = jl.account_id
    where jl.organization_id = ${organizationId}
      and t.project_id = ${projectId}
      and t.voided_at is null
      and (a.type = 'revenue' or a.type = 'expense')
      and (${from ?? null}::date is null or t.occurred_on >= ${from ?? null}::date)
      and (${to ?? null}::date is null or t.occurred_on <= ${to ?? null}::date)
    group by a.type
  `;

  let totalIncome = 0n;
  let totalExpense = 0n;

  for (const row of rows) {
    const debit = BigInt(row.debit as string);
    const credit = BigInt(row.credit as string);
    // 收入正常在贷方，费用正常在借方——与 getProfitLoss 同一句。
    if (row.type === 'revenue') totalIncome = credit - debit;
    else totalExpense = debit - credit;
  }

  return {
    projectId,
    projectName: project.name as string,
    totalIncomeMinor: totalIncome,
    totalExpenseMinor: totalExpense,
    netProfitMinor: totalIncome - totalExpense,
  };
}

/*
 * postgres.js 把 `date` 列解析成 JS Date，不是字符串。其余每一个
 * repository 的 mapper 都走 toIsoDate / formatDateOnly 把它转成
 * 'YYYY-MM-DD'（见 invoices.ts、bills.ts、payments.ts、fixed_assets.ts…），
 * 只有这里直接 `as string` 断言了一下。
 *
 * TypeScript 的类型断言不做任何运行时检查——编译通过，类型看上去是
 * string，运行时拿到的还是 Date。渲染到 JSX 里 React 就抛
 * 「Objects are not valid as a React child (found: [object Date])」，
 * 整页进 error boundary。
 *
 * 触发条件是「这条记录填了日期」，而此前的测试数据里没有一条填过，
 * 所以 1246 个单元测试、tsc、eslint 全绿。是灌进一份带日期的真实数据
 * 之后打开页面才看见的。
 */
function mapProject(row: Record<string, unknown>): ProjectRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    contactId: (row.contact_id as string | null) ?? null,
    contactName: (row.contact_name as string | null) ?? null,
    status: row.status as 'active' | 'completed' | 'cancelled',
    budgetMinor: row.budget_minor ? BigInt(row.budget_minor as string) : null,
    startDate: row.start_date ? toIsoDate(row.start_date as Date | string) : null,
    endDate: row.end_date ? toIsoDate(row.end_date as Date | string) : null,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as string),
  };
}
