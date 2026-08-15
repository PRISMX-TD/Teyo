import type { Tx } from '@/server/db/transaction';
import { can, type Action, type Role } from '@/server/domain/permissions';
import type { ChecklistState } from '@/components/dashboard/first-run-checklist';

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

/**
 * 每个清单项对应它指向的设置页要求的权限，单一定义供组件（决定渲染什么）
 * 与本文件（决定查什么）共用，防止两处判断权限时各写一份、慢慢走样。
 */
export const CHECKLIST_ACTIONS: Record<keyof ChecklistState, Action> = {
  hasMoneyAccount: 'account:manage',
  hasFirstTransaction: 'transaction:create',
  hasContact: 'account:manage',
  hasInvitedSomeone: 'member:manage',
};

/**
 * allowed 为假时直接短路返回 false，连查询都不发——角色看不到的项，
 * 不该去戳一张它读不到（或本就与它无关）的表。
 */
async function checklistFlag(
  allowed: boolean,
  run: () => Promise<{ done: boolean }[]>,
): Promise<boolean> {
  if (!allowed) return false;
  const rows = await run();
  return Boolean(rows[0]?.done);
}

/**
 * 首次引导清单四项的完成状态，按当前角色是否有权限行动来决定查不查、
 * 显不显示——这不是性能优化的副产品，是正确性要求：
 *
 * invitations 与 audit_logs 的读策略（0002_rls.sql）都只放行 owner/admin，
 * 与 accounts_read / contacts_read / transactions_read 用的
 * app_is_member 不同。dashboard 页只要求 transaction:read，bookkeeper 与
 * viewer 也能进来；如果不分角色地查这两张表，RLS 会把结果悄悄收窄成空集，
 * 这些角色看到的永远是「未完成」——而对应的链接
 * （settings/accounts、settings/contacts、settings/members）都要求
 * account:manage 或 member:manage，他们点进去只会被 requirePermission 拒绝。
 * 那是一个打不上勾、也点不开的死链接，不是单纯卡住的勾选框。
 *
 * 用 CHECKLIST_ACTIONS 里同一份权限映射来决定「查不查」，组件用它决定
 * 「显不显示」：一个角色看不到的项，这里也不会去查那张它读不到的表，
 * 两处判断永远对齐，不会出现「查了但被 RLS 清空」这种看似正常、实则
 * 一直失败的中间态。
 */
export async function getFirstRunChecklistState(
  tx: Tx,
  organizationId: string,
  role: Role,
): Promise<ChecklistState> {
  const canManageAccounts = can(role, CHECKLIST_ACTIONS.hasMoneyAccount);
  const canCreateTransactions = can(role, CHECKLIST_ACTIONS.hasFirstTransaction);
  const canManageMembers = can(role, CHECKLIST_ACTIONS.hasInvitedSomeone);

  const [hasMoneyAccount, hasFirstTransaction, hasContact, hasInvitedSomeone] = await Promise.all([
    checklistFlag(
      canManageAccounts,
      () => tx`
        select (
          exists(
            select 1 from accounts
            where organization_id = ${organizationId}
              and is_money_account = true
              and is_system = false
          )
          or exists(
            -- 光新建账户会漏掉最自然的第一反应：把种子里的 Cash / Bank
            -- Account 直接改成自己真实的账户名。renameAccount
            -- （server/actions/accounts.ts）把改名前后的名字记进
            -- audit_logs，这里认它作数，而不是去比对种子文案的字面值——
            -- 后者一旦种子文案改了，或者用户只改了其中一种语言，就会悄悄
            -- 失效。用 jsonb 的 ?| 运算符挑出 after 里带 nameEn/nameZh 键的记录，
            -- 把它和 setAccountActive 写的 after: {isActive} 区分开，
            -- 只有改名才算数，停用/恢复不算。
            select 1 from audit_logs al
            join accounts a on a.id = al.entity_id
            where al.organization_id = ${organizationId}
              and al.entity_type = 'account'
              and al.action = 'account.updated'
              and al.after ?| array['nameEn', 'nameZh']
              and a.is_money_account = true
          )
        ) as done
      `,
    ),
    checklistFlag(
      canCreateTransactions,
      () => tx`
        select exists(
          select 1 from transactions
          where organization_id = ${organizationId}
            and kind in ('income', 'expense')
            and voided_at is null
        ) as done
      `,
    ),
    checklistFlag(
      canManageAccounts,
      () => tx`
        select exists(
          select 1 from contacts
          where organization_id = ${organizationId}
        ) as done
      `,
    ),
    checklistFlag(
      canManageMembers,
      () => tx`
        select exists(
          select 1 from invitations
          where organization_id = ${organizationId}
        ) as done
      `,
    ),
  ]);

  return { hasMoneyAccount, hasFirstTransaction, hasContact, hasInvitedSomeone };
}
