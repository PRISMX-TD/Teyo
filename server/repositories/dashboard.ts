import type { Tx } from '@/server/db/transaction';

export type DashboardKpis = {
  monthIncome: bigint;
  monthExpense: bigint;
  netIncome: bigint;
  totalBankBalance: bigint;
  unpaidInvoices: bigint;
  unpaidBills: bigint;
  overdueInvoices: bigint;
  overdueBills: bigint;
};

export type MonthlyTrend = {
  month: string;
  income: bigint;
  expense: bigint;
};

export type ExpenseByCategory = {
  categoryNameEn: string | null;
  categoryNameZh: string | null;
  total: bigint;
};

export type BankBalance = {
  accountId: string;
  accountNameEn: string | null;
  accountNameZh: string | null;
  balance: bigint;
};

function monthRange(month: string): { start: string; nextStart: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Expected a YYYY-MM month, received "${month}".`);
  }
  const [year, m] = month.split('-').map(Number);
  if (m < 1 || m > 12) {
    throw new Error(`Expected a YYYY-MM month, received "${month}".`);
  }
  const start = `${month}-01`;
  const nextYear = m === 12 ? year + 1 : year;
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextStart = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return { start, nextStart };
}

function currentMonth(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export async function getDashboardKpis(
  tx: Tx,
  organizationId: string,
): Promise<DashboardKpis> {
  const { start, nextStart } = monthRange(currentMonth());

  const [row] = await tx`
    select
      coalesce(
        (select sum(base_amount_minor) from transactions
         where organization_id = ${organizationId}
           and kind = 'income'
           and voided_at is null
           and occurred_on >= ${start}::date
           and occurred_on < ${nextStart}::date),
        0
      ) as month_income,
      coalesce(
        (select sum(base_amount_minor) from transactions
         where organization_id = ${organizationId}
           and kind = 'expense'
           and voided_at is null
           and occurred_on >= ${start}::date
           and occurred_on < ${nextStart}::date),
        0
      ) as month_expense,
      coalesce((
        select sum(
          case when l.direction = 'debit'
            then l.base_amount_minor
            else -l.base_amount_minor end
        )
        from journal_lines l
        join transactions t on t.id = l.transaction_id
        join accounts a on a.id = l.account_id
        where a.organization_id = ${organizationId}
          and a.is_money_account
          and a.is_active
          and t.voided_at is null
      ), 0) as total_bank_balance,
      coalesce(
        (select sum(total_minor) from invoices
         where organization_id = ${organizationId}
           and status not in ('paid', 'voided')
           and voided_at is null),
        0
      ) as unpaid_invoices,
      coalesce(
        (select sum(total_minor) from bills
         where organization_id = ${organizationId}
           and status not in ('paid', 'voided')
           and voided_at is null),
        0
      ) as unpaid_bills,
      coalesce(
        (select sum(total_minor) from invoices
         where organization_id = ${organizationId}
           and status not in ('paid', 'voided')
           and voided_at is null
           and due_date < current_date),
        0
      ) as overdue_invoices,
      coalesce(
        (select sum(total_minor) from bills
         where organization_id = ${organizationId}
           and status not in ('paid', 'voided')
           and voided_at is null
           and due_date < current_date),
        0
      ) as overdue_bills
  `;

  const monthIncome = BigInt(row.month_income);
  const monthExpense = BigInt(row.month_expense);

  return {
    monthIncome,
    monthExpense,
    netIncome: monthIncome - monthExpense,
    totalBankBalance: BigInt(row.total_bank_balance),
    unpaidInvoices: BigInt(row.unpaid_invoices),
    unpaidBills: BigInt(row.unpaid_bills),
    overdueInvoices: BigInt(row.overdue_invoices),
    overdueBills: BigInt(row.overdue_bills),
  };
}

export async function getMonthlyTrends(
  tx: Tx,
  organizationId: string,
  months: number = 12,
): Promise<MonthlyTrend[]> {
  const endDate = new Date();
  const startY = endDate.getFullYear();
  const startM = endDate.getMonth() - months + 1;
  const startDate = new Date(startY, startM, 1);
  const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-01`;

  const rows = await tx`
    select
      to_char(occurred_on, 'YYYY-MM') as month,
      coalesce(sum(base_amount_minor) filter (where kind = 'income'), 0) as income,
      coalesce(sum(base_amount_minor) filter (where kind = 'expense'), 0) as expense
    from transactions
    where organization_id = ${organizationId}
      and voided_at is null
      and occurred_on >= ${startStr}::date
    group by to_char(occurred_on, 'YYYY-MM')
    order by month
  `;

  const resultMap = new Map<string, { income: bigint; expense: bigint }>();
  for (const row of rows) {
    resultMap.set(row.month as string, {
      income: BigInt(row.income as string),
      expense: BigInt(row.expense as string),
    });
  }

  const result: MonthlyTrend[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const data = resultMap.get(month);
    result.push({
      month,
      income: data?.income ?? BigInt(0),
      expense: data?.expense ?? BigInt(0),
    });
  }

  return result;
}

export async function getExpenseByCategory(
  tx: Tx,
  organizationId: string,
  year: number,
  month: number,
): Promise<ExpenseByCategory[]> {
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const { start, nextStart } = monthRange(monthStr);

  const rows = await tx`
    select
      c.name_en,
      c.name_zh,
      sum(t.base_amount_minor) as total
    from transactions t
    join categories c on c.id = t.category_id
    where t.organization_id = ${organizationId}
      and t.kind = 'expense'
      and t.voided_at is null
      and t.occurred_on >= ${start}::date
      and t.occurred_on < ${nextStart}::date
    group by c.id, c.name_en, c.name_zh
    order by sum(t.base_amount_minor) desc, c.id
  `;

  return rows.map((row) => ({
    categoryNameEn: (row.name_en as string | null) ?? null,
    categoryNameZh: (row.name_zh as string | null) ?? null,
    total: BigInt(row.total as string),
  }));
}

export async function getBankBalances(
  tx: Tx,
  organizationId: string,
): Promise<BankBalance[]> {
  const rows = await tx`
    select
      a.id,
      a.name_en,
      a.name_zh,
      coalesce((
        select sum(
          case when l.direction = 'debit'
            then l.base_amount_minor
            else -l.base_amount_minor end
        )
        from journal_lines l
        join transactions t on t.id = l.transaction_id
        where l.account_id = a.id
          and t.voided_at is null
      ), 0) as balance
    from accounts a
    where a.organization_id = ${organizationId}
      and a.is_money_account
      and a.is_active
    order by a.sort_order, a.id
  `;

  return rows.map((row) => ({
    accountId: row.id as string,
    accountNameEn: (row.name_en as string | null) ?? null,
    accountNameZh: (row.name_zh as string | null) ?? null,
    balance: BigInt(row.balance as string),
  }));
}
