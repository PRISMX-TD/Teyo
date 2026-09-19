import type { Tx } from '@/server/db/transaction';
import type { OrgContext } from '@/server/auth/guard';
import { assertPeriodOpen } from '@/server/domain/period-lock';
import { findAccountByCode } from '@/server/repositories/accounts';
import { getYearEndClosingBalances } from '@/server/repositories/reports';
import { POSTING_ACCOUNT_CODES } from '@/server/services/account-seed';
import {
  deleteFiscalYearClosing,
  findFiscalYearClosing,
  insertFiscalYearClosing,
  type FiscalYearClosingRow,
} from '@/server/repositories/fiscal-year-closings';
import { recordAudit } from '@/server/repositories/audit-logs';
import { markVoided } from '@/server/repositories/transactions';

/**
 * 年结（把一个财年的收入与费用结转进留存收益）与财年边界。
 *
 * ============================================================
 * 为什么必须有年结
 * ============================================================
 * 在这之前，`retained-earnings`（留存收益）这个科目从建库起就没有任何一处
 * 代码对它过账。资产负债表上那行「本年利润」是 getBalanceSheet 的
 * `currentYearEarnings` 参数——调用方算好一个数、临时拼上去的一行，不产生
 * 分录、不落库。
 *
 * 第一年这样看不出问题：公司只有一个年度，「本年利润」就是全部累计利润，
 * 资产 = 负债 + 权益 + 本年利润 照样成立。
 *
 * 第二年开始就不成立了。报表页把损益期间取成「本年度至今」，于是
 * currentYearEarnings 只含**今年**的利润，而去年赚的钱既不在 equityTotal
 * 里（没人把它记进留存收益），也不在 currentYearEarnings 里（不在期间内）。
 * 资产负债表会差出恰好一整年的利润，而 I5 那条不变量会忠实地把它报成
 * 「不平」——一张对不上、且没有任何办法对上的资产负债表。
 *
 * 年结就是补上那一步：财年结束时，把每个损益科目的余额冲平，差额落进
 * 留存收益。此后那一年的利润**在账上**，不再靠报表临时拼。
 *
 * ============================================================
 * 财年为什么不是日历年
 * ============================================================
 * 报表页此前写死 `${today.slice(0, 4)}-01-01`。马来西亚的中小企业财年常常
 * 不是 1 月起（跟着母公司、跟着行业惯例、或者当初注册时随手选的）。财年
 * 边界决定损益表的期间、现金流量表的期间、以及年结记在哪一天——差一个月，
 * 整张损益表就是错的期间，而它看起来完全正常。
 *
 * 0024 迁移给 organizations 加了 fiscal_year_start_month（1–12）。本文件的
 * fiscalYearFor / previousFiscalYear 是把那一个数字翻译成起止日期的唯一
 * 实现，页面层不再各自拼字符串。
 */

export class YearEndCloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YearEndCloseError';
  }
}

/** 一个财年，闭区间 [start, end]，两端都是 YYYY-MM-DD。 */
export type FiscalYear = {
  /** 财年第一天，永远是某个月的 1 号。 */
  start: string;
  /** 财年最后一天，永远是某个月的最后一天。年结分录记在这一天。 */
  end: string;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 某年某月有多少天。闰年规则写全（能被 4 整除、但整百年份要能被 400 整除）。
 *
 * 不用 `new Date(y, m, 0).getDate()`：那条路要构造一个带时区的 Date，而这个
 * 文件从头到尾只处理「日历上的日期」，一个时区都不该碰。Date 一旦进来，
 * 在 UTC+8 的机器上跑和在 UTC 的 Vercel 上跑就可能给出不同的财年——而财年
 * 错一天，年结分录就记进了下一个财年。
 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function assertFiscalYearStartMonth(startMonth: number): void {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new YearEndCloseError(
      `Fiscal year start month must be a whole number between 1 and 12, received ${startMonth}.`,
    );
  }
}

/**
 * 以 startYear 年的 startMonth 月 1 日开始的那个财年。
 *
 * 结束日 = 起始月的前一个月的最后一天，年份按是否跨自然年决定：
 *   startMonth = 1  → 12 月，同一年（2026-01-01 .. 2026-12-31，即日历年）
 *   startMonth = 7  → 6 月，下一年（2025-07-01 .. 2026-06-30）
 *   startMonth = 12 → 11 月，下一年（2025-12-01 .. 2026-11-30）
 *
 * 只有 startMonth = 1 时财年不跨自然年，这就是那两个三元表达式的全部内容。
 */
function fiscalYearFromStartYear(startYear: number, startMonth: number): FiscalYear {
  assertFiscalYearStartMonth(startMonth);

  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? startYear : startYear + 1;

  return {
    start: `${startYear}-${pad2(startMonth)}-01`,
    end: `${endYear}-${pad2(endMonth)}-${pad2(daysInMonth(endYear, endMonth))}`,
  };
}

/** 从 YYYY-MM-DD 取出年、月两个整数。格式不对就抛错，绝不静默当成别的日期。 */
function parseIsoDate(date: string): { year: number; month: number } {
  const match = ISO_DATE.exec(date);
  if (!match) {
    throw new YearEndCloseError(`Expected a YYYY-MM-DD date, received "${date}".`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new YearEndCloseError(`"${date}" is not a real calendar date.`);
  }
  return { year, month };
}

/**
 * date 这一天落在哪个财年里。
 *
 * 判据只有一句：这一天的月份还没到起始月，说明它属于**上一个**开始的财年。
 * 例：财年 7 月起，2026-03-15 的月份 3 < 7，所以它属于 2025-07-01 那一个。
 */
export function fiscalYearFor(date: string, startMonth: number): FiscalYear {
  assertFiscalYearStartMonth(startMonth);
  const { year, month } = parseIsoDate(date);
  return fiscalYearFromStartYear(month >= startMonth ? year : year - 1, startMonth);
}

/**
 * date 所在财年的**上一个**财年。年结默认结的是它——本财年还没过完。
 *
 * 实现是「起始年减一」而不是「从 start 减一天再算一遍」：后者要做日期减法，
 * 而这个文件刻意不引入任何日期运算（见 daysInMonth 上的注释）。财年的起始
 * 年份连续递增，减一就是上一个，没有例外。
 */
export function previousFiscalYear(date: string, startMonth: number): FiscalYear {
  assertFiscalYearStartMonth(startMonth);
  const { year, month } = parseIsoDate(date);
  return fiscalYearFromStartYear((month >= startMonth ? year : year - 1) - 1, startMonth);
}

/* =========================================================================
   年结分录
   ========================================================================= */

/** 年结分录的一行。amountMinor 恒为正，方向由 direction 表达。 */
export type ClosingLine = {
  accountId: string;
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  /** 'equity' 的那一行是留存收益本身，界面上要和被冲平的损益科目区分开。 */
  accountType: 'revenue' | 'expense' | 'equity';
  direction: 'debit' | 'credit';
  amountMinor: bigint;
};

export type ClosingPlan = {
  period: FiscalYear;
  /** 逐行借贷。借方合计恒等于贷方合计——见 buildClosingPlan 末尾的断言。 */
  lines: ClosingLine[];
  /** 本财年净利润（本位币最小单位）。正数为盈利。 */
  netIncomeMinor: bigint;
  /** 留存收益科目 id。撤销与过账都要用它。 */
  retainedEarningsAccountId: string;
};

/**
 * 算出某个财年的年结分录，但**不写任何东西**。
 *
 * 界面必须先拿它做预览：年结会永久改变用户的财务报表数字（去年的利润从
 * 「本年利润」那一行搬进留存收益），点下去之前必须看得见每一行借贷。
 *
 * 规则：
 *   - 收入科目正常余额在贷方 → 借它的余额，把它冲成 0；
 *   - 费用科目正常余额在借方 → 贷它的余额；
 *   - 差额进 retained-earnings：盈利则贷，亏损则借。
 *
 * 方向按**实际净发生额的符号**决定，不按科目类型硬编码。理由：一个收入
 * 科目完全可能带借方余额（销售退回全部挂在 sales 上、或者一笔记反了后来
 * 用红字冲回），这时它要被**贷**才能归零。按类型硬编码会在这种账上记出一笔
 * 让余额翻倍的分录，而借贷合计照样相等，配平触发器一个字都不会说。
 *
 * 余额为零的科目不出行：journal_lines.amount_minor 有 > 0 的 CHECK 约束，
 * 一条零金额的行会被数据库直接拒绝，而用户看到的是一句读不懂的约束报错。
 */
export async function buildClosingPlan(
  tx: Tx,
  ctx: OrgContext,
  period: FiscalYear,
): Promise<ClosingPlan> {
  const retainedEarnings = await findAccountByCode(
    tx,
    ctx.organizationId,
    POSTING_ACCOUNT_CODES.retainedEarnings,
  );
  if (!retainedEarnings) {
    throw new YearEndCloseError(
      'This company has no Retained Earnings account, so the year cannot be closed.',
    );
  }

  const balances = await getYearEndClosingBalances(
    tx,
    ctx.organizationId,
    period.start,
    period.end,
  );

  const lines: ClosingLine[] = [];
  // 全部损益科目的「借 - 贷」合计。每一笔分录都配平，所以这个数恰好是
  // 费用合计减收入合计，也就是净利润的相反数——下面直接取反得到净利润，
  // 不必分别累加收入与费用再相减（两条路算出来必然相同，留一条就少一处
  // 可以彼此漂移的实现）。
  let signedTotal = 0n;

  for (const balance of balances) {
    if (balance.netMinor === 0n) continue;

    signedTotal += balance.netMinor;

    // netMinor > 0 表示这个科目此刻挂着借方余额，要贷同样的金额才归零。
    const debitBalance = balance.netMinor > 0n;
    lines.push({
      accountId: balance.accountId,
      code: balance.code,
      nameEn: balance.nameEn,
      nameZh: balance.nameZh,
      accountType: balance.type,
      direction: debitBalance ? 'credit' : 'debit',
      amountMinor: debitBalance ? balance.netMinor : -balance.netMinor,
    });
  }

  const netIncomeMinor = -signedTotal;

  if (lines.length === 0) {
    throw new YearEndCloseError(
      'There is no income or expense in this financial year, so there is nothing to close.',
    );
  }

  // 净利润为零时不出这一行：金额为零的分录行过不了 amount_minor > 0 的
  // CHECK，而此时损益科目那几行本来就已经互相配平（收入恰好等于费用）。
  if (netIncomeMinor !== 0n) {
    lines.push({
      accountId: retainedEarnings.id,
      code: retainedEarnings.code,
      nameEn: retainedEarnings.nameEn,
      nameZh: retainedEarnings.nameZh,
      accountType: 'equity',
      // 盈利 → 贷留存收益（权益增加）；亏损 → 借留存收益（权益减少）。
      direction: netIncomeMinor > 0n ? 'credit' : 'debit',
      amountMinor: netIncomeMinor > 0n ? netIncomeMinor : -netIncomeMinor,
    });
  }

  // 自检。postJournal 与数据库触发器都会再查一遍，但那是在写入路径上；
  // 预览也走这个函数，而预览不经过任何写入——一张借贷不等的预览表如果只
  // 在用户点下「结转」之后才报错，那张表在屏幕上的那几秒是在说谎。
  const debitTotal = sumByDirection(lines, 'debit');
  const creditTotal = sumByDirection(lines, 'credit');
  if (debitTotal !== creditTotal) {
    throw new YearEndCloseError(
      `The closing entry does not balance: debits ${debitTotal} vs credits ${creditTotal}.`,
    );
  }

  return { period, lines, netIncomeMinor, retainedEarningsAccountId: retainedEarnings.id };
}

function sumByDirection(lines: readonly ClosingLine[], direction: 'debit' | 'credit'): bigint {
  return lines
    .filter((line) => line.direction === direction)
    .reduce((sum, line) => sum + line.amountMinor, 0n);
}

/* =========================================================================
   过账与撤销
   ========================================================================= */

/**
 * 把一张年结分录写进总账的函数。
 *
 * ============================================================
 * 为什么这里是一个参数，而不是直接 import postJournal
 * ============================================================
 * 记账的唯一写入出口是 server/posting/post-journal.ts 的 postJournal，
 * 而它记的 kind 完全由 server/domain/posting-templates.ts 的 kindFor(event)
 * 决定，分录形状由同一个文件的 templateFor(event) 决定。现有的 PostingEvent
 * 九种事件里，没有任何一种能表达「n 个科目一次结平」，也没有任何一种会
 * 落成 kind = 'closing'——那个枚举值由 0023 迁移加进数据库，但
 * server/domain/ledger.ts 的 TransactionKind 联合类型里还没有它。
 *
 * 这两个文件都不在本次改动的范围内（见任务说明），所以年结的那一笔分录
 * 今天还写不进去。把写入做成一个参数，好处是除了那十几行之外的**全部**
 * 逻辑——幂等、权限、期间检查、审计、fiscal_year_closings 的登记与撤销——
 * 今天就能写完、能被测试钉住；边界扩展落地后，调用方只需换掉传进来的这
 * 一个函数，本文件一个字都不用动。
 *
 * 需要的扩展见本次任务报告；形状是 PostingEvent 上加一种
 * `{ type: 'closing'; lines: DraftLineSpec[] }`，templateFor 原样返回它的
 * lines，kindFor 返回 'closing'。
 */
/**
 * 年结分录今天还能不能真的过账。
 *
 * 界面用它决定显示「结转」按钮还是那条说明。做成一个常量而不是让用户点
 * 下去才拿到一句报错：一个点了必错的按钮，等于让用户替我们发现这个功能
 * 没做完。边界扩展落地后，这一行与 server/actions/year_end.ts 里
 * postClosingEntry 的函数体是同一次改动的两处。
 *
 * 放在这个文件而不是放在 actions 里：'use server' 文件的每一个导出都必须
 * 是 async 函数，一个布尔常量在那里会让 next build 直接失败。
 */
export const YEAR_END_POSTING_AVAILABLE = true;

export type ClosingPoster = (
  tx: Tx,
  ctx: OrgContext,
  entry: {
    occurredOn: string;
    description: string;
    clientUuid: string;
    lines: readonly ClosingLine[];
  },
) => Promise<{ transactionId: string }>;

export type CloseFiscalYearInput = {
  period: FiscalYear;
  /** 公司时区下的今天（todayInOrg），用来挡住「结一个还没过完的财年」。 */
  today: string;
  /** 交易表头的备注。调用方按语言拼好。 */
  description: string;
  /** postJournal 的幂等键，由调用方生成。 */
  clientUuid: string;
};

/**
 * 结转一个财年。必须在 withTransaction 内调用。
 *
 * 顺序是刻意的：
 *   1. 财年必须已经结束——结一个还没过完的年会把「还会再发生的收入费用」
 *      提前冲平，而第二天记的那一笔又会让损益科目重新有余额，那张已经
 *      结转过的损益表从此再也对不上。
 *   2. 期间未封账——年结记在财年最后一天，如果用户已经把账封到那一天
 *      之后，postJournal 会在最后一步拒绝。提前查是为了让用户读到
 *      「先解锁」，而不是一句从写入路径深处冒出来的报错。
 *   3. 幂等——同一财年只能结一次。数据库的
 *      fiscal_year_closings_unique_period 唯一约束是最终防线（两个人同时
 *      点各自都会查到「还没结过」），这一步只负责把那条裸约束报错换成一句
 *      人话。两者都要有：少了约束会真的结两次，少了这一步用户看不懂。
 *   4. 过账 → 5. 登记 → 6. 审计，全在同一个事务里，要么都成要么都不成。
 */
export async function closeFiscalYear(
  tx: Tx,
  ctx: OrgContext,
  input: CloseFiscalYearInput,
  post: ClosingPoster,
): Promise<{ closingId: string; transactionId: string; netIncomeMinor: bigint }> {
  const { period } = input;

  if (period.end > input.today) {
    throw new YearEndCloseError(
      `This financial year has not ended yet (it runs to ${period.end}), so it cannot be closed.`,
    );
  }

  // 与 postJournal 第 1 步同一个判断、同一个函数。这里先查一遍只是为了
  // 换一句更早、更好懂的报错；真正的闸门仍然在写入路径上。
  assertPeriodOpen(period.end, ctx.lockedUntil, ctx.role);

  const existing = await findFiscalYearClosing(tx, ctx.organizationId, period.start);
  if (existing) {
    throw new YearEndCloseError(
      `The financial year ${period.start} to ${period.end} has already been closed. Undo that closing first if you need to redo it.`,
    );
  }

  const plan = await buildClosingPlan(tx, ctx, period);

  const { transactionId } = await post(tx, ctx, {
    // 年结按会计惯例记在财年最后一天。
    occurredOn: period.end,
    description: input.description,
    clientUuid: input.clientUuid,
    lines: plan.lines,
  });

  const closingId = await insertFiscalYearClosing(tx, {
    organizationId: ctx.organizationId,
    periodStart: period.start,
    periodEnd: period.end,
    transactionId,
    netIncomeMinor: plan.netIncomeMinor,
    closedBy: ctx.userId,
  });

  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'fiscal_year.closed',
    entityType: 'fiscal_year_closing',
    entityId: closingId,
    after: {
      periodStart: period.start,
      periodEnd: period.end,
      transactionId,
      // bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。
      netIncomeMinor: plan.netIncomeMinor.toString(),
      lines: plan.lines.map((line) => ({
        accountId: line.accountId,
        accountCode: line.code,
        direction: line.direction,
        amountMinor: line.amountMinor.toString(),
      })),
    },
  });

  return { closingId, transactionId, netIncomeMinor: plan.netIncomeMinor };
}

/**
 * 撤销一次年结：删登记行 + 作废那笔分录。必须在 withTransaction 内调用。
 *
 * 为什么是「删 + 作废」而不是「改」：fiscal_year_closings 上**没有** update
 * 策略（见 0024 迁移），一次年结的内容在它发生的那一刻就定死了。要改只能
 * 撤销重做，而撤销就是这里。
 *
 * 分录用软删除而不是硬删：账目要可追溯，删掉分录就查不出当初结转了什么。
 * transactions 表在数据库层也根本没有 delete 策略。三个作废字段必须同时
 * 写入（transactions_void_fields_together 约束），markVoided 已经保证了这点。
 *
 * 顺序是先作废分录再删登记行：反过来的话，如果作废那一步失败，事务会回滚，
 * 结果一样；但读代码的人会先看到「登记没了」，再去猜分录怎么办。先处理
 * 账、再处理登记，与「账是主、登记是索引」这个事实同序。
 */
export async function undoFiscalYearClose(
  tx: Tx,
  ctx: OrgContext,
  closing: FiscalYearClosingRow,
  reason: string,
): Promise<void> {
  // 撤销会让那一年的损益重新回到损益科目上，是一次实打实的账务变更，
  // 与年结本身同级，因此同样要过期间检查。
  assertPeriodOpen(closing.periodEnd, ctx.lockedUntil, ctx.role);

  if (closing.transactionId !== null) {
    await markVoided(tx, ctx.organizationId, closing.transactionId, ctx.userId, reason);
  }

  await deleteFiscalYearClosing(tx, ctx.organizationId, closing.id);

  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'fiscal_year.reopened',
    entityType: 'fiscal_year_closing',
    entityId: closing.id,
    before: {
      periodStart: closing.periodStart,
      periodEnd: closing.periodEnd,
      transactionId: closing.transactionId,
      netIncomeMinor: closing.netIncomeMinor.toString(),
    },
    after: { voidReason: reason },
  });
}
