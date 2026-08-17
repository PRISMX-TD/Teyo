import type { Tx } from '@/server/db/transaction';
import { LedgerError, type TransactionKind } from '@/server/domain/ledger';

export type RecurringTransactionRow = {
  id: string;
  organizationId: string;
  kind: TransactionKind;
  description: string | null;
  amount: string;
  currency: string;
  debitAccountId: string;
  creditAccountId: string;
  categoryId: string | null;
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  interval: number;
  startDate: string;
  endDate: string | null;
  nextDueDate: string;
  isActive: boolean;
  createdAt: string;
};

function formatDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapRecurring(row: Record<string, unknown>): RecurringTransactionRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    kind: row.kind as TransactionKind,
    description: (row.description as string | null) ?? null,
    amount: row.amount as string,
    currency: row.currency as string,
    debitAccountId: row.debit_account_id as string,
    creditAccountId: row.credit_account_id as string,
    categoryId: (row.category_id as string | null) ?? null,
    frequency: row.frequency as RecurringTransactionRow['frequency'],
    interval: Number(row.interval),
    startDate: formatDate(row.start_date as Date | string),
    endDate: row.end_date ? formatDate(row.end_date as Date | string) : null,
    nextDueDate: formatDate(row.next_due_date as Date | string),
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function listRecurring(
  tx: Tx,
  orgId: string,
): Promise<RecurringTransactionRow[]> {
  const rows = await tx`
    select id, organization_id, kind, description, amount, currency,
           debit_account_id, credit_account_id, category_id,
           frequency, "interval", start_date, end_date, next_due_date,
           is_active, created_at
    from recurring_transactions
    where organization_id = ${orgId}
    order by next_due_date asc
  `;
  return rows.map(mapRecurring);
}

export async function insertRecurring(
  tx: Tx,
  row: {
    organizationId: string;
    kind: TransactionKind;
    description: string | null;
    amount: string;
    currency: string;
    debitAccountId: string;
    creditAccountId: string;
    categoryId: string | null;
    frequency: RecurringTransactionRow['frequency'];
    interval: number;
    startDate: string;
    endDate: string | null;
    nextDueDate: string;
  },
): Promise<{ id: string }> {
  // 三个日期列的 ::date 都必须写在插值外面。end_date 这一处原先是把类型转换
  // 拼进了插值内部（endDate + '::date'），于是绑定参数的值是字符串
  // '2026-05-15::date' 而不是日期：postgres.js 先 describe 得知该列是 date，
  // 随后按 date 序列化这个字符串，直接抛 Invalid time value。结果是任何带
  // 结束日期的定期规则根本建不出来——而结束日期正是补记逻辑最需要的那一列。
  const [inserted] = await tx`
    insert into recurring_transactions (
      organization_id, kind, description, amount, currency,
      debit_account_id, credit_account_id, category_id,
      frequency, "interval", start_date, end_date, next_due_date
    ) values (
      ${row.organizationId}, ${row.kind}, ${row.description},
      ${row.amount}, ${row.currency},
      ${row.debitAccountId}, ${row.creditAccountId}, ${row.categoryId},
      ${row.frequency}, ${row.interval},
      ${row.startDate}::date, ${row.endDate}::date,
      ${row.nextDueDate}::date
    )
    returning id
  `;
  return { id: inserted.id as string };
}

export async function updateRecurring(
  tx: Tx,
  orgId: string,
  id: string,
  fields: {
    description?: string | null;
    amount?: string;
    currency?: string;
    debitAccountId?: string;
    creditAccountId?: string;
    categoryId?: string | null;
    frequency?: RecurringTransactionRow['frequency'];
    interval?: number;
    startDate?: string;
    endDate?: string | null;
    nextDueDate?: string;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const column = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    patch[column] = value;
  }

  const columns = Object.keys(patch);
  if (columns.length === 0) return;

  // postgres.js 的 tx(obj, ...cols) 形式生成参数化的 "col" = $n 列表，
  // 日期列传字符串即可，Postgres 会按目标列类型隐式转换，
  // 不需要（也不能）内联 ::date —— 内联会退回字符串拼接。
  await tx`
    update recurring_transactions
    set ${tx(patch, ...columns)}
    where id = ${id} and organization_id = ${orgId}
  `;
}

export async function setRecurringActive(
  tx: Tx,
  orgId: string,
  id: string,
  active: boolean,
): Promise<void> {
  await tx`
    update recurring_transactions
    set is_active = ${active}
    where id = ${id} and organization_id = ${orgId}
  `;
}

/**
 * 返回在今天（含）之前到期、且还欠着分录的活跃定期规则，并锁住这些行。
 *
 * 两处与直觉不同的地方：
 *
 * 1. 结束日期看的是 next_due_date <= end_date，不是 end_date >= today。
 *    后者（改之前的写法）会在规则的结束日期一过去，就把整条规则排除掉——
 *    连它还欠着的那几期一起排除。一条上个月到期结束的月租规则，最后一两笔
 *    分录就这样永远不会生成，而且界面上什么都不会说。真正该问的是「这条
 *    规则还有没有下一期落在 end_date 之内」，那就是 next_due_date <= end_date。
 *    单期是否越过 end_date 由调用方在补记循环里再判一次，两者是互补的：
 *    这里挡掉已经跑完的规则，循环挡掉本次补记中越界的那一期。
 *
 * 2. for update。没有行锁时，两次同时发起的生成（两个浏览器标签页就够）在
 *    READ COMMITTED 下会读到同一批规则，各自入账一遍，随后第二次的 UPDATE
 *    只是阻塞一下再照常写入——没有任何报错，账上多出一整批重复分录。
 *    加上 for update 后，第二次会在第一次提交前停在行锁上；第一次提交后
 *    Postgres 用 EvalPlanQual 拿最新版本重跑 where 子句，发现 next_due_date
 *    已经被推到今天之后，这条规则直接落选——第二次因此什么也不做。
 *
 *    order by 里的 id 不是装饰：加了 for update 之后，锁的获取顺序就是这条
 *    order by 的顺序（LockRows 在 Sort 之上，排序是阻塞节点，全部排完才逐行
 *    加锁）。只按 next_due_date 排序时，同一天到期的几条规则之间没有确定的
 *    先后——synchronize_seqscans 会让两个并发的顺序扫描从不同的数据块开始，
 *    喂给排序的输入顺序不同，并列键的输出顺序就可能相反，那正是死锁的条件。
 *    补上主键让排序成为全序，两个并发运行必然以同一顺序取锁，死锁不可能发生，
 *    后来者只会等待。
 */
export async function getDueRecurring(
  tx: Tx,
  orgId: string,
  today: string,
): Promise<RecurringTransactionRow[]> {
  const rows = await tx`
    select id, organization_id, kind, description, amount, currency,
           debit_account_id, credit_account_id, category_id,
           frequency, "interval", start_date, end_date, next_due_date,
           is_active, created_at
    from recurring_transactions
    where organization_id = ${orgId}
      and is_active = true
      and next_due_date <= ${today}::date
      and (end_date is null or next_due_date <= end_date)
    order by next_due_date asc, id asc
    for update
  `;
  return rows.map(mapRecurring);
}

/** 某年某月（monthIndex 从 0 起）有多少天。第 3 个参数传 0 得到上个月最后一天。 */
function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** 全部按 UTC 构造，绕开本地时区的夏令时——日期算术不该受时钟调整影响。 */
function isoFromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 计算下一次到期日。
 *
 * 月/季/年三种频率必须把「日」夹到目标月的最后一天。改之前用的是
 * d.setMonth(d.getMonth() + interval)：2026-01-31 加一个月，二月没有 31 号，
 * JavaScript 会往后溢出成 2026-03-03。那不是「下个月的同一天」，而是一次
 * 静默的日期漂移，且从此再也回不到 31 号。以前只有一次生成会踩到它，
 * 补记功能上线后每一期都会踩，误差逐期累积。
 *
 * 闰日同理：2028-02-29 加一年必须落在 2029-02-28，而不是 2029-03-01。
 */
export function computeNextDueDate(
  frequency: RecurringTransactionRow['frequency'],
  interval: number,
  currentDue: string,
): string {
  const [year, month, day] = currentDue.split('-').map(Number);
  const monthIndex = month - 1;

  if (frequency === 'daily' || frequency === 'weekly') {
    const days = frequency === 'daily' ? interval : 7 * interval;
    return isoFromUtc(new Date(Date.UTC(year, monthIndex, day + days)));
  }

  const months =
    frequency === 'monthly' ? interval : frequency === 'quarterly' ? 3 * interval : 12 * interval;

  const absoluteMonth = monthIndex + months;
  const targetYear = year + Math.floor(absoluteMonth / 12);
  const targetMonthIndex = ((absoluteMonth % 12) + 12) % 12;
  const clampedDay = Math.min(day, lastDayOfMonth(targetYear, targetMonthIndex));

  return isoFromUtc(new Date(Date.UTC(targetYear, targetMonthIndex, clampedDay)));
}

/**
 * 单次运行里，单条规则最多补记多少期。
 *
 * 必须有上限：一条每日规则三年没跑过，一次就是一千多笔交易、两千多行分录
 * 挤进同一个事务，锁与内存都不好看。
 *
 * 取 60，因为它覆盖了除「每日」外每种频率的任何现实积压——60 期是 5 年的
 * 每月、超过 1 年的每周、15 年的每季、60 年的每年。只有每日规则可能撞到它，
 * 而一条每日规则积压满 60 天，本身就是该让用户看见的状态，所以撞上限的规则
 * 会被报告成 deferred 而不是被静默截断。next_due_date 每次都推进到已入账的
 * 下一期，下一次运行接着补，一笔都不会丢。
 */
export const MAX_CATCH_UP_PER_RULE = 60;

/**
 * 列出这条规则本次该补的到期日。
 *
 * 与 computeNextDueDate 一样是纯函数、不碰数据库，放在这里是因为两者是同一
 * 套排期算术：一个算「下一期是哪天」，一个算「到今天为止还欠哪几期」，分开
 * 放会让读者以为上限和 end_date 的判断在别处还有第二份。
 *
 * 每走一步都要求日期严格前进。interval = 0 时 computeNextDueDate 是恒等函数
 * （五个分支都是），没有这条断言的话循环会把同一天塞满 MAX_CATCH_UP_PER_RULE
 * 次，每笔一个新的 clientUuid，幂等拦不住，一笔月租直接乘以 60；而且因为游标
 * 没变，之后每次点击都再来 60 笔——账面还完全配平，数据库的配平触发器一点都
 * 看不出来。
 *
 * 这里抛错而不是 break：break 会把一条坏掉的规则悄悄变成「没什么可做的规则」，
 * 用户永远不知道自己的重复间隔填坏了。抛出去会让它出现在 blocked 里。
 */
export function plannedDueDates(
  rule: Pick<RecurringTransactionRow, 'frequency' | 'interval' | 'nextDueDate' | 'endDate'>,
  today: string,
): string[] {
  const dates: string[] = [];
  let cursor = rule.nextDueDate;

  while (
    cursor <= today &&
    (rule.endDate === null || cursor <= rule.endDate) &&
    dates.length < MAX_CATCH_UP_PER_RULE
  ) {
    dates.push(cursor);

    const next = computeNextDueDate(rule.frequency, rule.interval, cursor);
    if (next <= cursor) {
      throw new LedgerError(
        'This rule repeats every 0 periods, so its next date never moves forward. ' +
          'Set how often it repeats to at least 1.',
      );
    }
    cursor = next;
  }

  return dates;
}
