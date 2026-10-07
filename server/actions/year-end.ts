'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { closeFiscalYearSchema, undoFiscalYearCloseSchema } from '@/lib/schemas';
import { requirePermission, todayInOrg } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { postJournal } from '@/server/posting/post-journal';
import {
  getFiscalYearClosingById,
  listFiscalYearClosings,
  type FiscalYearClosingRow,
} from '@/server/repositories/fiscal-year-closings';
import { getFiscalYearStartMonth } from '@/server/repositories/organizations';
import {
  buildClosingPlan,
  closeFiscalYear as closeFiscalYearInLedger,
  fiscalYearFor,
  previousFiscalYear,
  undoFiscalYearClose,
  YearEndCloseError,
  type ClosingPlan,
  type ClosingPoster,
  type FiscalYear,
} from '@/server/services/year-end-close';

/**
 * 年结的 server actions。
 *
 * ============================================================
 * 权限：为什么用 period:lock 而不是 organization:transfer
 * ============================================================
 * 0024 迁移把 fiscal_year_closings 的 insert/delete 策略限死在 owner，应用层
 * 必须用一个同样只有 owner 有的 Action，否则界面放行、数据库拒绝，用户看到
 * 的是一句裸的 RLS 报错——这正是 0022 那一轮修掉的那类故障。
 *
 * server/domain/permissions.ts 里只有 owner 的动作有三个：period:lock、
 * organization:transfer、organization:delete。不新增 Action 是因为那个文件
 * 不在本次改动范围内（新增一个 'period:close' 还要同时改 0022 的矩阵测试）。
 *
 * 三个里选 period:lock：
 *   - organization:transfer 是「把公司交给别人」，与账务无关，借它的名字
 *     会让权限矩阵读起来像在说「能转让公司的人才能记账」；
 *   - organization:delete 更远；
 *   - period:lock 是「决定某段期间的账还能不能动」。年结恰好是同一类
 *     事情：它把一整年的损益推进留存收益，此后那一年的损益表不该再变。
 *     两者连界面位置都该挨着（设置 → 公司 / 年结）。
 * 这是借用，不是精确匹配——报告里已列出「建议新增 period:close」这件事。
 */

/** 报表/年结页要的全部东西，一次查完。 */
export type YearEndOverview = {
  /** 公司时区下的今天。界面上的「财年还没结束」提示要用它。 */
  today: string;
  fiscalYearStartMonth: number;
  /** 本财年（还在进行中，通常不结转）。 */
  currentYear: FiscalYear;
  /** 上一个财年——「结转」按钮默认结的就是它。 */
  targetYear: FiscalYear;
  /** targetYear 的预览分录；算不出来（没有损益、缺科目）时是那句原因。 */
  preview: ClosingPlan | null;
  previewError: string | null;
  /** targetYear 已经结过的话，就是那条登记行。 */
  existingClosing: FiscalYearClosingRow | null;
  history: FiscalYearClosingRow[];
  /** 期间封账到哪天。年结记在财年最后一天，界面要据此提示先解锁。 */
  lockedUntil: string | null;
};

export async function getYearEndOverview(orgSlug: string): Promise<YearEndOverview> {
  const context = await requirePermission(orgSlug, 'period:lock');
  const today = todayInOrg(context);

  return withTransaction(context.userId, async (tx) => {
    const fiscalYearStartMonth = await getFiscalYearStartMonth(tx, context.organizationId);
    const currentYear = fiscalYearFor(today, fiscalYearStartMonth);
    const targetYear = previousFiscalYear(today, fiscalYearStartMonth);

    const history = await listFiscalYearClosings(tx, context.organizationId);
    const existingClosing =
      history.find((row) => row.periodStart === targetYear.start) ?? null;

    // 预览算不出来不是错误，是一种正常状态（一家刚开张的公司上一个财年
    // 什么都没发生）。抛出去会让整页 500，而这一页恰恰是用来告诉用户
    // 「能不能结、为什么不能」的。
    let preview: ClosingPlan | null = null;
    let previewError: string | null = null;
    if (!existingClosing) {
      try {
        preview = await buildClosingPlan(tx, context, targetYear);
      } catch (error) {
        if (!(error instanceof YearEndCloseError)) throw error;
        previewError = error.message;
      }
    }

    return {
      today,
      fiscalYearStartMonth,
      currentYear,
      targetYear,
      preview,
      previewError,
      existingClosing,
      history,
      lockedUntil: context.lockedUntil,
    };
  });
}

/**
 * 年结分录的写入口。
 *
 * ============================================================
 * 它怎么走记账边界
 * ============================================================
 * 记账的唯一出口是 server/posting/post-journal.ts 的 postJournal。年结曾经
 * 卡在这里：现有的 PostingEvent 没有一种能表达「n 个科目一次结平」，也没有
 * 一种会落成 kind = 'closing'。
 *
 * 那两样都补上了（server/domain/posting-templates.ts 的 'closing' 事件、
 * server/domain/ledger.ts 的 TransactionKind、0023 的枚举值、0024 把
 * 'closing' 并进 transactions_category_matches_kind 的「不带分类」那一支）。
 * 所以这里不再需要任何替身，直接调 postJournal。
 *
 * 几个参数为什么是这几个值：
 *
 *   currency = ctx.baseCurrency —— 年结是纯本位币分录。各损益科目的余额
 *     本来就已经是本位币（journal_lines.base_amount_minor），结转不涉及
 *     任何一次换算。
 *   manualRate = '1' —— 同上。币种等于本位币时 resolveRate 本来就返回 1，
 *     显式传是为了让这笔交易的 rate_source 记成 'manual' 而不是 'auto'：
 *     'auto' 的含义是「查了汇率表」，而这里一次都没查。
 *   manualRateEntry = 'unavailable' —— 这个参数只在「查不到缓存汇率」那条
 *     路径上被读，而本位币永远走不到那里。传 'unavailable' 是因为年结界面
 *     上确实没有填汇率的地方（见 server/posting/rate.ts 的 ManualRateEntry：
 *     它问的是「这个入口的界面上有没有能填汇率的地方」）。
 *   categoryId = null —— kind = 'closing' 不带分类（0024 约束）。
 */
const postClosingEntry: ClosingPoster = async (tx, ctx, entry) => {
  const lines = entry.lines.map((line) => ({
    accountId: line.accountId,
    direction: line.direction,
    amountMinor: line.amountMinor,
  }));

  // 表头金额取借方合计。templateFor 的 'closing' 分支会断言这个数与分录
  // 的借方合计相等——传错了当场报错，而不是落成一笔表头与分录对不上的账。
  const debitTotal = lines
    .filter((line) => line.direction === 'debit')
    .reduce((sum, line) => sum + line.amountMinor, 0n);

  const { transactionId } = await postJournal(tx, ctx, {
    event: { type: 'closing', lines, amountMinor: debitTotal },
    occurredOn: entry.occurredOn,
    description: entry.description,
    currency: ctx.baseCurrency,
    manualRate: '1',
    manualRateEntry: 'unavailable',
    categoryId: null,
    clientUuid: entry.clientUuid,
    sourceType: 'fiscal_year_closing',
  });

  return { transactionId };
};

/**
 * 结转一个财年。owner only，幂等，全程一个事务。
 *
 * periodStart 由表单带回来，但服务端**不信它**：拿到之后按公司自己的财年
 * 起始月重新算一遍上一个财年，对不上就拒绝。不这么做的话，任何 owner 都
 * 能构造一个任意的 period_start 去结一段不存在的「财年」，而唯一约束只
 * 保证同一个 period_start 不重复，管不了它是不是一个真的财年。
 */
export async function closeFiscalYear(
  orgSlug: string,
  input: { periodStart: string },
): Promise<{ closingId: string; transactionId: string }> {
  const context = await requirePermission(orgSlug, 'period:lock');
  const data = closeFiscalYearSchema.parse(input);
  const today = todayInOrg(context);

  const result = await withTransaction(context.userId, async (tx) => {
    const startMonth = await getFiscalYearStartMonth(tx, context.organizationId);
    const period = resolveRequestedFiscalYear(today, startMonth, data.periodStart);

    return closeFiscalYearInLedger(
      tx,
      context,
      {
        period,
        today,
        description: `Year-end closing ${period.start} – ${period.end}`,
        // 幂等键。年结不像表单提交那样会被双击重放（真正的幂等由
        // fiscal_year_closings 的唯一约束保证），所以这里不需要一个可复现
        // 的哈希——随机 uuid 就够，而且撤销重做时必须是一个**新**的键：
        // 沿用旧键会让 postJournal 的幂等查询命中那笔已作废的交易，直接
        // 返回 deduplicated，于是撤销之后再也结不上。
        clientUuid: randomUUID(),
      },
      postClosingEntry,
    );
  });

  revalidateYearEnd(orgSlug);
  return { closingId: result.closingId, transactionId: result.transactionId };
}

/** 撤销一次年结：删登记行 + 作废那笔分录。owner only。 */
export async function undoYearEndClose(
  orgSlug: string,
  input: { closingId: string; reason: string },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'period:lock');
  const data = undoFiscalYearCloseSchema.parse(input);

  await withTransaction(context.userId, async (tx) => {
    const closing = await getFiscalYearClosingById(tx, context.organizationId, data.closingId);
    if (!closing) {
      throw new YearEndCloseError('That year-end closing was not found in this company.');
    }
    await undoFiscalYearClose(tx, context, closing, data.reason);
  });

  revalidateYearEnd(orgSlug);
}

/**
 * 表单送回来的 periodStart 必须真的是「上一个财年」的第一天。
 *
 * 只认上一个财年而不认任意历史财年：更早的财年要么已经结过（唯一约束挡
 * 住），要么是被跳过的——而跳着结会让留存收益的构成失去顺序，一旦中间
 * 那一年后来补结，两次结转的期间是断开的，谁也说不清哪一段算过了。
 * 需要补结更早的年度时，正确做法是先把中间的逐年结完，那要一个这个界面
 * 目前没有的「选择财年」入口，不在本次范围内。
 */
function resolveRequestedFiscalYear(
  today: string,
  startMonth: number,
  requestedStart: string,
): FiscalYear {
  const period = previousFiscalYear(today, startMonth);
  if (period.start !== requestedStart) {
    throw new YearEndCloseError(
      `The financial year starting ${requestedStart} is not the one waiting to be closed (that is ${period.start}). Reload the page and try again.`,
    );
  }
  return period;
}

function revalidateYearEnd(orgSlug: string): void {
  revalidatePath(`/${orgSlug}/settings/year-end`);
  // 年结改的是报表上的数字，不是设置。这四页全都要重算：留存收益变了
  // （资产负债表、试算平衡表、总账），损益表的期间口径也变了。
  revalidatePath(`/${orgSlug}/reports`);
  revalidatePath(`/${orgSlug}/general-ledger`);
  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}`);
}
