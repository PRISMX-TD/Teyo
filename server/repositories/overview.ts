import type { Tx } from '@/server/db/transaction';

export type MonthTotals = {
  incomeMinor: bigint;
  expenseMinor: bigint;
  netMinor: bigint;
};

export type AccountBalance = {
  accountId: string;
  nameEn: string | null;
  nameZh: string | null;
  balanceMinor: bigint;
};

export type CategoryShare = {
  categoryId: string;
  nameEn: string | null;
  nameZh: string | null;
  totalMinor: bigint;
};

/**
 * 把 YYYY-MM 转成该月首日与次月首日，用半开区间 [start, nextStart) 查询。
 * 不用 between：那是闭区间，月末当天的记录会算进下个月的查询里。
 */
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

/**
 * 收支合计走 transactions.kind，不走分录：转账两侧都是资金账户，
 * 从分录看无法区分「转账」与「收入」，只有交易头上的 kind 说得清。
 * 一律用 base_amount_minor，多币种才能加在一起。
 */
export async function getMonthTotals(
  tx: Tx,
  organizationId: string,
  month: string,
): Promise<MonthTotals> {
  const { start, nextStart } = monthRange(month);

  const [row] = await tx`
    select
      coalesce(sum(base_amount_minor) filter (where kind = 'income'), 0) as income,
      coalesce(sum(base_amount_minor) filter (where kind = 'expense'), 0) as expense
    from transactions
    where organization_id = ${organizationId}
      and voided_at is null
      and occurred_on >= ${start}::date
      and occurred_on < ${nextStart}::date
  `;

  const incomeMinor = BigInt(row.income);
  const expenseMinor = BigInt(row.expense);

  return { incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor };
}

/**
 * 余额从分录算，不从交易头算：资金科目是资产类，余额 = 借方合计 - 贷方合计。
 * 这样转账、多币种、以后的赊账都自动正确，不必为每种 kind 写一遍加减号。
 *
 * 余额用标量子查询而不是 join + group by：一是没有任何分录的账户也要出现在
 * 列表里（余额 0），否则新建的钱包在概览页上整行消失，看起来像账户丢了；
 * 二是 join 版本要先把 accounts 与 transactions 交叉再过滤，行数白涨一轮。
 * coalesce 包在子查询外面，空集合返回 null 时补 0。
 */
export async function getAccountBalances(
  tx: Tx,
  organizationId: string,
  asOf: string,
): Promise<AccountBalance[]> {
  const rows = await tx`
    select
      a.id,
      a.name_en,
      a.name_zh,
      coalesce((
        select sum(
          case when l.direction = 'debit' then l.base_amount_minor else -l.base_amount_minor end
        )
        from journal_lines l
        join transactions t on t.id = l.transaction_id
        where l.account_id = a.id
          and t.voided_at is null
          and t.occurred_on <= ${asOf}::date
      ), 0) as balance
    from accounts a
    where a.organization_id = ${organizationId}
      and a.is_money_account
      and a.is_active
    order by a.sort_order, a.id
  `;

  return rows.map((row) => ({
    accountId: row.id as string,
    nameEn: (row.name_en as string | null) ?? null,
    nameZh: (row.name_zh as string | null) ?? null,
    balanceMinor: BigInt(row.balance as string),
  }));
}

/** 支出分类占比。只看 kind = 'expense'，转账没有分类，收入不属于这里。 */
export async function getExpenseByCategory(
  tx: Tx,
  organizationId: string,
  month: string,
): Promise<CategoryShare[]> {
  const { start, nextStart } = monthRange(month);

  const rows = await tx`
    select
      c.id,
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
    categoryId: row.id as string,
    nameEn: (row.name_en as string | null) ?? null,
    nameZh: (row.name_zh as string | null) ?? null,
    totalMinor: BigInt(row.total as string),
  }));
}
