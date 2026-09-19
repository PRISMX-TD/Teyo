import type { Tx } from '@/server/db/transaction';
import { can, type Action, type Role } from '@/server/domain/permissions';
import type { ChecklistState } from '@/components/dashboard/first-run-checklist';
import {
  getApAging,
  getArAging,
  sumAgingOutstanding,
  sumAgingOverdue,
} from '@/server/repositories/aging';

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

/**
 * 这家公司此刻的「今天」，YYYY-MM-DD。
 *
 * 为什么不是 `new Date().toISOString().slice(0, 10)`：那取的是**服务端的
 * UTC 日期**。本产品的主市场在 UTC+8（organizations.timezone 默认
 * 'Asia/Kuala_Lumpur'），于是本地时间 00:00–08:00 之间，服务端的 UTC 日期
 * 还停在**昨天**——用户一大早打开首页，「本月收入」在每月 1 号那八个小时里
 * 显示的是上个月，「逾期」少算一天，而屏幕上没有任何东西提示他这是时区问题。
 * server/auth/guard.ts 的 toDateOnly 与 app/api/cron/exchange-rates/route.ts
 * 都专门注释过这个坑，只是页面层一直没跟上。
 *
 * 为什么在 Postgres 里算而不是在 Node 里算：`now() at time zone tz` 用的是
 * 数据库自带的完整 IANA 时区库，夏令时、历史偏移全都是对的；在 Node 侧要
 * 得到同样的结果得走 Intl.DateTimeFormat 再解析回来，多一层可出错的转换，
 * 而这一整个函数存在的理由就是「不要再自己算日期」。
 *
 * 为什么先在 pg_timezone_names 里查一次：lib/schemas.ts 对 timezone 只校验
 * 「非空、不超过 60 字」，并没有校验它是不是合法的 IANA 名称。一个非法值
 * 会让 `now() at time zone` 直接抛错，整张首页变成 500——而首页恰恰是用户
 * 唯一的入口。查不到就退回 UTC：日期可能差一天，但页面还在，而且这与
 * 「时区没配对」这件事的严重程度相称。
 *
 * 为什么不改 server/auth/guard.ts 给 OrgContext 加上 timezone：guard.ts 不在
 * 本次可改范围内。这个函数只依赖 organizationId，任何仓储函数都能自己调用，
 * 不需要调用方先准备好上下文。代价是每次多一次极便宜的查询；真正的归宿仍然
 * 是把 timezone 放进 OrgContext（resolveOrgContext 已经在查 organizations 这
 * 张表，多取一列是零成本，而且 React.cache 会让它整个请求只查一次）——这一条
 * 写进交付报告里，由能改 guard.ts 的人收口。
 */
export async function getOrganizationToday(
  tx: Tx,
  organizationId: string,
): Promise<string> {
  const rows = await tx`
    select to_char((now() at time zone s.tz)::date, 'YYYY-MM-DD') as today
    from (
      select coalesce(
               (select n.name from pg_timezone_names n where n.name = o.timezone),
               'UTC'
             ) as tz
      from organizations o
      where o.id = ${organizationId}
    ) s
  `;

  const today = rows.at(0)?.today as string | undefined;
  if (!today) {
    // 公司不存在（或 RLS 把它挡掉了）。这里不静默退回 UTC 的今天：那会让
    // 一个本该是「你不是这家公司的成员」的问题，伪装成一张数字全是 0 的
    // 正常报表。
    throw new Error(`Organization ${organizationId} not found while resolving its local date.`);
  }
  return today;
}

/**
 * 首页 KPI。
 *
 * 这次改掉的三件事：
 *
 * 1. **「今天/本月」按公司时区算**，不再用服务端 UTC。见 getOrganizationToday。
 *
 * 2. **资金余额加上日期上界**。原来的 total_bank_balance 只过滤了
 *    `voided_at is null`，没有任何 occurred_on 条件——**未来日期的交易被计入
 *    了现在的余额**。定期交易、预先录入的下月房租都会落在未来，于是首页显示
 *    的「银行余额」比对账单上的数字大，而用户对不出差在哪。口径与
 *    reports.ts 的 moneyBalanceAsOf 对齐：按 is_money_account 聚合（不是
 *    'cash'/'bank' 字面量，用户自建的银行账户也要算）、`occurred_on <= 今天`、
 *    不看 is_active（一个被归档但仍有余额的账户，它的钱并没有消失——这与
 *    reports.ts 的 I10 是同一条道理）。
 *
 * 3. **应收/应付按本位币算未结余额**。原来是
 *    `sum(total_minor) where status not in ('paid','voided')`：既不扣已收的
 *    款，又把各币种的原币金额直接相加，然后按本位币显示。这两条错误的完整
 *    论证写在 server/repositories/aging.ts 的 getArAging 顶部；这里直接复用
 *    那两个函数，而不是把同一段 SQL 再写一遍——「什么叫未结」「什么叫逾期」
 *    在整个产品里必须只有一处定义，否则首页与报表页会各说各话，而那正是
 *    用户最容易发现、最难解释的一类不一致。
 *
 * 已知的口径边界（不是这次能修的）：
 * - monthIncome / monthExpense 走 transactions.kind，而单据过账一律落成
 *   kind = 'journal'（见 server/domain/posting-templates.ts 的 kindFor）。
 *   所以一张发票确认的收入不会出现在这两个数里。这是既有设计——这两个数
 *   问的是「这个月收付了多少钱」，不是「这个月赚了多少」；后者在损益表上。
 * - 有外币单据尚未过账时，unpaidInvoices / unpaidBills 会**少算**那几张
 *   （getArAging 把它们排除并单列提示）。首页的 KPI 是一个纯 bigint，
 *   没有地方挂提示，所以这里只能少算而不是算错——报表页会把提示显示出来。
 */
export async function getDashboardKpis(
  tx: Tx,
  organizationId: string,
): Promise<DashboardKpis> {
  const today = await getOrganizationToday(tx, organizationId);
  const { start, nextStart } = monthRange(today.slice(0, 7));

  const [kpiRows, arAging, apAging] = await Promise.all([
    tx`
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
            and t.voided_at is null
            and t.occurred_on <= ${today}::date
        ), 0) as total_bank_balance
    `,
    getArAging(tx, organizationId, today),
    getApAging(tx, organizationId, today),
  ]);

  const row = kpiRows[0];
  const monthIncome = BigInt(row.month_income);
  const monthExpense = BigInt(row.month_expense);

  return {
    monthIncome,
    monthExpense,
    netIncome: monthIncome - monthExpense,
    totalBankBalance: BigInt(row.total_bank_balance),
    unpaidInvoices: sumAgingOutstanding(arAging),
    unpaidBills: sumAgingOutstanding(apAging),
    overdueInvoices: sumAgingOverdue(arAging),
    overdueBills: sumAgingOverdue(apAging),
  };
}

/**
 * 最近 N 个月的收支走势。
 *
 * 窗口的终点是**公司时区下的本月**，不是服务端 UTC 的本月：否则在 UTC+8 的
 * 每月 1 号凌晨，走势图会整体少画一格，而那一格恰好是用户最关心的当月。
 *
 * 顺带补上了上界 `occurred_on < 次月初`：原来只有下界，未来日期的交易会被
 * `to_char(occurred_on,'YYYY-MM')` 分到一个不在 result 数组里的月份键上，
 * 于是它们既不显示、也不报错，只是无声地不见了。加上上界之后，「不显示」
 * 变成了一个明确的查询条件，而不是一个巧合。
 */
export async function getMonthlyTrends(
  tx: Tx,
  organizationId: string,
  months: number = 12,
): Promise<MonthlyTrend[]> {
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new Error(`Monthly trend window must be an integer between 1 and 120, received ${months}.`);
  }

  const today = await getOrganizationToday(tx, organizationId);
  const [endYear, endMonth] = today.slice(0, 7).split('-').map(Number);

  // 从终点往回数 months - 1 个月得到起点。用「零基月份」算再折回年月，
  // 不经 Date 对象——Date 会把这个纯粹的年月运算重新拖进时区问题里。
  const endIndex = endYear * 12 + (endMonth - 1);
  const startIndex = endIndex - (months - 1);
  const monthKeys: string[] = [];
  for (let i = 0; i < months; i++) {
    const index = startIndex + i;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    monthKeys.push(`${y}-${String(m).padStart(2, '0')}`);
  }

  const { start } = monthRange(monthKeys[0]);
  const { nextStart } = monthRange(monthKeys[monthKeys.length - 1]);

  const rows = await tx`
    select
      to_char(occurred_on, 'YYYY-MM') as month,
      coalesce(sum(base_amount_minor) filter (where kind = 'income'), 0) as income,
      coalesce(sum(base_amount_minor) filter (where kind = 'expense'), 0) as expense
    from transactions
    where organization_id = ${organizationId}
      and voided_at is null
      and occurred_on >= ${start}::date
      and occurred_on < ${nextStart}::date
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

  return monthKeys.map((month) => {
    const data = resultMap.get(month);
    return {
      month,
      income: data?.income ?? 0n,
      expense: data?.expense ?? 0n,
    };
  });
}

/**
 * 某个月的支出分类占比。
 *
 * 期间由调用方传入（year/month），这个函数不自己假设「今天」——报表函数
 * 一律接受传入的期间，是这个项目的既有约定。调用方
 * （app/(app)/[orgSlug]/page.tsx）目前用 `new Date()` 算 year/month，
 * 也就是服务端 UTC 的年月，在 UTC+8 每月 1 号的头八小时会传成上个月；
 * 那一处不在本次可改范围内，已写进交付报告。
 */
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

/**
 * 每个资金账户的余额。
 *
 * 与 getDashboardKpis 的 totalBankBalance 必须逐条对得上，否则首页上会出现
 * 「明细加起来不等于合计」这种最难解释的不一致。所以两处用同一套口径：
 * - 同一个日期上界（公司时区下的今天），未来日期的交易不计入；
 * - 同样不按 'cash'/'bank' 字面量，而按 is_money_account；
 * - 归档账户只要还有余额就保留（I10：把一个有余额的账户从列表里抹掉，
 *   合计里那笔钱就成了对不上的差额，而用户看不到它去哪了）。
 */
export async function getBankBalances(
  tx: Tx,
  organizationId: string,
): Promise<BankBalance[]> {
  const today = await getOrganizationToday(tx, organizationId);

  const rows = await tx`
    with balance as (
      select
        a.id,
        a.name_en,
        a.name_zh,
        a.is_active,
        a.sort_order,
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
            and t.occurred_on <= ${today}::date
        ), 0) as balance
      from accounts a
      where a.organization_id = ${organizationId}
        and a.is_money_account
    )
    select id, name_en, name_zh, balance
    from balance
    where is_active or balance <> 0
    order by sort_order, id
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
              and is_active = true
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
            --
            -- 两支都要求 is_active = true：这一项问的是「用户现在有没有一个
            -- 明确认领的资金账户」，是当下状态，不是历史上发生过什么。
            -- 建过、或者改过名之后又把它停用了，不该继续算数——不然一旦
            -- 满足过就是单向棘轮，永远打勾，即便这家公司此刻实际上一个
            -- 自定义/已改名的资金账户都没有在用。
            select 1 from audit_logs al
            join accounts a on a.id = al.entity_id
            where al.organization_id = ${organizationId}
              and al.entity_type = 'account'
              and al.action = 'account.updated'
              and al.after ?| array['nameEn', 'nameZh']
              and a.is_money_account = true
              and a.is_active = true
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
