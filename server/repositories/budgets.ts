import type { Tx } from '@/server/db/transaction';

export type BudgetRow = {
  id: string;
  organizationId: string;
  accountId: string;
  year: number;
  month: number;
  budgetMinor: bigint;
};

export type BudgetVsActualRow = {
  accountId: string;
  accountCode: string;
  accountNameEn: string | null;
  accountNameZh: string | null;
  accountType: string;
  isMoneyAccount: boolean;
  budgetMinor: bigint;
  actualMinor: bigint;
  varianceMinor: bigint;
};

function mapBudget(row: Record<string, unknown>): BudgetRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    accountId: row.account_id as string,
    year: Number(row.year),
    month: Number(row.month),
    budgetMinor: BigInt(row.budget_minor as string),
  };
}

export async function getBudget(
  tx: Tx,
  orgId: string,
  accountId: string,
  year: number,
  month: number,
): Promise<BudgetRow | null> {
  const rows = await tx`
    select id, organization_id, account_id, year, month, budget_minor
    from budgets
    where organization_id = ${orgId}
      and account_id = ${accountId}
      and year = ${year}
      and month = ${month}
  `;
  const row = rows.at(0);
  return row ? mapBudget(row) : null;
}

export async function setBudget(
  tx: Tx,
  orgId: string,
  accountId: string,
  year: number,
  month: number,
  amount: bigint,
): Promise<void> {
  await tx`
    insert into budgets (organization_id, account_id, year, month, budget_minor)
    values (${orgId}, ${accountId}, ${year}, ${month}, ${amount.toString()})
    on conflict (organization_id, account_id, year, month)
    do update set budget_minor = ${amount.toString()}
  `;
}

export async function listBudgets(
  tx: Tx,
  orgId: string,
  year: number,
): Promise<BudgetRow[]> {
  const rows = await tx`
    select id, organization_id, account_id, year, month, budget_minor
    from budgets
    where organization_id = ${orgId}
      and year = ${year}
    order by month, account_id
  `;
  return rows.map(mapBudget);
}

/** 预算 vs 实际：每个活跃科目的预算与实际发生额对比。 */
export async function getBudgetVsActual(
  tx: Tx,
  orgId: string,
  year: number,
  month: number,
): Promise<BudgetVsActualRow[]> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // 下个月第一天
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  const rows = await tx`
    select
      a.id as account_id,
      a.code as account_code,
      a.name_en,
      a.name_zh,
      a.type,
      a.is_money_account,
      coalesce(b.budget_minor, 0) as budget_minor,
      coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor::bigint
                        else -l.base_amount_minor::bigint end), 0) as actual_minor
    from accounts a
    left join budgets b on b.account_id = a.id
      and b.organization_id = ${orgId}
      and b.year = ${year}
      and b.month = ${month}
    left join journal_lines l on l.account_id = a.id
      and l.organization_id = ${orgId}
    left join transactions t on t.id = l.transaction_id
      and t.organization_id = ${orgId}
      and t.voided_at is null
      and t.occurred_on >= ${startDate}::date
      and t.occurred_on < ${endDate}::date
    where a.organization_id = ${orgId}
      and a.is_active = true
    group by a.id, a.code, a.name_en, a.name_zh, a.type, a.is_money_account, b.budget_minor
    order by a.sort_order, a.id
  `;

  return rows.map((r) => {
    const budgetMinor = BigInt(r.budget_minor as string);
    const actualMinor = BigInt(r.actual_minor as string);
    return {
      accountId: r.account_id as string,
      accountCode: r.account_code as string,
      accountNameEn: (r.name_en as string | null) ?? null,
      accountNameZh: (r.name_zh as string | null) ?? null,
      accountType: r.type as string,
      isMoneyAccount: r.is_money_account as boolean,
      budgetMinor,
      actualMinor,
      varianceMinor: budgetMinor - actualMinor,
    };
  });
}
