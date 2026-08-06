import type { Tx } from '@/server/db/transaction';

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
 * 汇总项目关联交易的收入与费用。
 *
 * 收入：所有 journal_lines 中 account 类型为 'revenue' 且 transaction.project_id 匹配的 base_amount_minor 总和。
 * 费用：所有 journal_lines 中 account 类型为 'expense' 且 transaction.project_id 匹配的 base_amount_minor 总和。
 */
export async function getProjectProfitability(
  tx: Tx,
  organizationId: string,
  projectId: string,
  from?: string,
  to?: string,
): Promise<ProjectProfitability> {
  const projectRows = await tx`
    select id, name from projects
    where id = ${projectId} and organization_id = ${organizationId}
  `;
  const project = projectRows[0];
  const projectName = project ? (project.name as string) : '';

  const incomeRows = await tx`
    select coalesce(sum(jl.base_amount_minor), 0) as total
    from journal_lines jl
    join transactions t on t.id = jl.transaction_id
    join accounts a on a.id = jl.account_id
    where jl.organization_id = ${organizationId}
      and t.project_id = ${projectId}
      and a.type = 'revenue'
      and (${from ?? null}::date is null or t.occurred_on >= ${from ?? null}::date)
      and (${to ?? null}::date is null or t.occurred_on <= ${to ?? null}::date)
  `;

  const expenseRows = await tx`
    select coalesce(sum(jl.base_amount_minor), 0) as total
    from journal_lines jl
    join transactions t on t.id = jl.transaction_id
    join accounts a on a.id = jl.account_id
    where jl.organization_id = ${organizationId}
      and t.project_id = ${projectId}
      and a.type = 'expense'
      and (${from ?? null}::date is null or t.occurred_on >= ${from ?? null}::date)
      and (${to ?? null}::date is null or t.occurred_on <= ${to ?? null}::date)
  `;

  const totalIncome = BigInt(incomeRows[0].total as string);
  const totalExpense = BigInt(expenseRows[0].total as string);

  return {
    projectId,
    projectName,
    totalIncomeMinor: totalIncome,
    totalExpenseMinor: totalExpense,
    netProfitMinor: totalIncome - totalExpense,
  };
}

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
    startDate: (row.start_date as string | null) ?? null,
    endDate: (row.end_date as string | null) ?? null,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as string),
  };
}
