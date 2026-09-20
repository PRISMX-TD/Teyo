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
  assertBudgetPeriod(year, month);
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

/**
 * 预算期间的合法范围。
 *
 * year/month 一路从界面传到这里，原来没有任何校验：month = 13 会拼出
 * `2026-13-01`，Postgres 报的是一句 date/time field value out of range，
 * 用户读到的是数据库的原始报错而不是「月份要在 1 到 12 之间」。year 更隐蔽，
 * 一个手滑打成 20265 的年份不会报错，只会安静地返回一整页 0 —— 看起来像
 * 「这个月什么都没发生」，而不是「你输错了」。
 *
 * budgets 表上已有 `month between 1 and 12` 的 CHECK，但那只挡写入，
 * 挡不住读取；而读取才是这个函数唯一做的事。
 */
const MIN_BUDGET_YEAR = 1900;
const MAX_BUDGET_YEAR = 9999;

export function assertBudgetPeriod(year: number, month: number): void {
  if (!Number.isInteger(year) || year < MIN_BUDGET_YEAR || year > MAX_BUDGET_YEAR) {
    throw new Error(`Budget year must be an integer between ${MIN_BUDGET_YEAR} and ${MAX_BUDGET_YEAR}, received ${year}.`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Budget month must be an integer between 1 and 12, received ${month}.`);
  }
}

/**
 * 预算 vs 实际：每个科目在指定月份的预算与实际发生额对比。
 *
 * ## 原来的写法为什么算错
 *
 * 之前是 `accounts left join journal_lines left join transactions`，而作废与
 * 日期两个条件挂在 **transactions 的 ON 子句**上：
 *
 *   left join transactions t on t.id = l.transaction_id
 *     and t.voided_at is null and t.occurred_on >= ... and t.occurred_on < ...
 *
 * 这与 phase 1A 在 getTrialBalance / getBalanceSheet 上修掉的是同一类 bug：
 * 挂在 LEFT JOIN 的 ON 子句上的条件对驱动表不起过滤作用。ON 不满足时
 * `t.*` 全部为 NULL，但左边的 `l` 行**一条都不会少**——而 sum 里只引用了
 * `l.direction` / `l.base_amount_minor`，压根不碰 `t`。于是：
 *
 *   1. actual_minor 是该科目**有史以来**的全部发生额，不是这一个月的；
 *   2. 已作废的交易照样被算进去。
 *
 * 而 budget 是单月的，于是「实际」与「预算」根本不在同一个尺度上，
 * 变体分析（variance）显示的数字毫无意义——而且因为它总是偏大，界面上
 * 看起来像是「每个科目都严重超支」，用户不会怀疑是查询写错了。
 *
 * ## 现在的写法
 *
 * 照 reports.ts:50-71 的形状：先用**内连接**子查询把作废与期间条件做在
 * journal_lines/transactions 上（内连接才能让这两个条件真正生效），按科目
 * 聚合出 actual；再 LEFT JOIN 回 accounts，这样没有任何分录的科目仍然会
 * 带着 0 出现在列表里。
 *
 * ## 期间口径
 *
 * 半开区间 [月初, 次月初)——预算是按自然月切的，这与 overview.ts 的
 * monthRange 一致。这里刻意**不**改成报表那套闭区间 [from, to]：闭区间需要
 * 算出「这个月的最后一天」，而半开区间只需要「下个月第一天」，后者不必处理
 * 闰年和大小月。两种写法覆盖的日期集合完全相同。
 *
 * ## 归档科目（I10 的同一条道理）
 *
 * 原来是 `a.is_active = true`，一刀切掉所有归档科目。但一个科目可以在本月
 * 有发生额、也可以挂着本月的预算，之后才被归档——把它整行删掉，用户看到的
 * 是「这笔钱不见了」，预算合计与实际合计都会因此少一块，且没有任何提示。
 * 与 reports.ts 对归档科目的处理保持同一条规则：只丢弃**既没有预算也没有
 * 实际发生额**的归档科目。
 */
export async function getBudgetVsActual(
  tx: Tx,
  orgId: string,
  year: number,
  month: number,
): Promise<BudgetVsActualRow[]> {
  assertBudgetPeriod(year, month);

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  // 下个月第一天
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  const rows = await tx`
    with actual as (
      select
        l.account_id,
        sum(case when l.direction = 'debit' then l.base_amount_minor
                 else -l.base_amount_minor end) as net
      from journal_lines l
      join transactions t on t.id = l.transaction_id
      where l.organization_id = ${orgId}
        and t.voided_at is null
        and t.occurred_on >= ${startDate}::date
        and t.occurred_on < ${endDate}::date
      group by l.account_id
    )
    select
      a.id as account_id,
      a.code as account_code,
      a.name_en,
      a.name_zh,
      a.type,
      a.is_money_account,
      coalesce(b.budget_minor, 0) as budget_minor,
      coalesce(x.net, 0) as actual_minor
    from accounts a
    left join budgets b on b.account_id = a.id
      and b.organization_id = ${orgId}
      and b.year = ${year}
      and b.month = ${month}
    left join actual x on x.account_id = a.id
    where a.organization_id = ${orgId}
      and (a.is_active
           or coalesce(b.budget_minor, 0) <> 0
           or coalesce(x.net, 0) <> 0)
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
