import { RATE_SCALE, convertToBaseMinor, type RateSource } from './exchange-rate';
import { sumMinor } from './money';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export type TransactionKind = 'income' | 'expense' | 'transfer' | 'journal';
export type Direction = 'debit' | 'credit';

export type DraftJournalLine = {
  accountId: string;
  direction: Direction;
  amountMinor: bigint;
  baseAmountMinor: bigint;
};

export type DraftLineSpec = {
  accountId: string;
  direction: Direction;
  /** This line's amount in the original transaction currency. All lines must sum to a debit/credit balance. */
  amountMinor: bigint;
};

export type BuildLinesContext = {
  currency: string;
  baseCurrency: string;
  scaledRate: bigint;
};

/**
 * Builds a balanced journal from an arbitrary number of lines (n >= 2).
 *
 * 谁借谁贷不在这里决定，而在 server/domain/posting-templates.ts 的
 * templateFor：这个函数只认 DraftLineSpec 上已经写好的 direction。
 *
 * 这里原来还有一个 buildJournalLines，把 income/expense/transfer/journal
 * 四种操作各自映射成一对固定的借贷分录。templateFor 接管之后它在生产代码
 * 里一个调用者都没有了，却仍然留着第二份「哪种操作借哪个科目」的映射——
 * 两份记账方向的定义，正是本阶段要删掉的东西，也正是本计划已经出过一次的
 * 那种 bug 的形状（转账的借贷两端被写反，照样配平、照样没人看得出来）。
 * 已删除；方向只剩 templateFor 一处定义。
 *
 * n >= 2 而不是恰好 2：phase 4 posts invoices (debit receivable / credit
 * revenue / credit output tax -- three lines) and asset disposals (four lines).
 *
 * Each line is converted to base currency independently via
 * `convertToBaseMinor`, which rounds half up per line. Rounding each line
 * on its own can leave the two base-currency sides a cent apart even though
 * the original-currency sides balance exactly -- see the comment below on
 * how that residual is absorbed.
 */
export function buildLines(specs: DraftLineSpec[], ctx: BuildLinesContext): DraftJournalLine[] {
  const { currency, baseCurrency, scaledRate } = ctx;

  if (specs.length < 2) {
    throw new LedgerError('A transaction needs at least two journal lines.');
  }
  if (scaledRate <= 0n) {
    throw new LedgerError('Exchange rate must be greater than zero.');
  }
  for (const spec of specs) {
    if (spec.amountMinor <= 0n) {
      // 用户读得懂的说法。这条会原样出现在记账表单上，而「journal line」
      // 对一个没有会计基础的用户不是任何东西——他刚才输入的是一个金额。
      // 对 n 行事件同样成立：任何一行为零，这笔账的金额就有问题。
      throw new LedgerError('Transaction amount must be greater than zero.');
    }
  }

  const sumSpecsByDirection = (direction: Direction) =>
    sumMinor(specs.filter((spec) => spec.direction === direction).map((spec) => spec.amountMinor));

  // The specs must already balance in the original currency. If they don't,
  // that's bad input from the caller -- throw rather than silently plugging
  // the gap, which would mask a bug upstream.
  if (sumSpecsByDirection('debit') !== sumSpecsByDirection('credit')) {
    throw new LedgerError('Journal lines are not balanced in transaction currency.');
  }

  const lines: DraftJournalLine[] = specs.map((spec) => ({
    accountId: spec.accountId,
    direction: spec.direction,
    amountMinor: spec.amountMinor,
    baseAmountMinor: convertToBaseMinor({
      amountMinor: spec.amountMinor,
      currency,
      baseCurrency,
      scaledRate,
    }),
  }));

  const sumLinesBaseByDirection = (direction: Direction) =>
    sumMinor(lines.filter((line) => line.direction === direction).map((line) => line.baseAmountMinor));

  const debitBase = sumLinesBaseByDirection('debit');
  const creditBase = sumLinesBaseByDirection('credit');
  const baseDiff = debitBase - creditBase;

  if (baseDiff !== 0n) {
    // Per-line rounding left the base-currency sides a hair apart. Absorb
    // the difference into the largest line on the short side (by original
    // amountMinor, among lines sharing that side's direction) rather than
    // the last line: the largest line minimises the relative size of the
    // correction, and plugging the largest line is the conventional
    // accounting treatment -- landing on the last line would just be an
    // accident of iteration order.
    //
    // This line deliberately stops equalling its own convertToBaseMinor.
    // assertLineInvariants (I3, below) runs immediately after this at the
    // posting boundary, and it allows exactly this much and no more: one
    // line, off by exactly the residual the two sides were apart. Its
    // comment carries the reasoning.
    const shortDirection: Direction = baseDiff > 0n ? 'credit' : 'debit';
    const candidates = lines.filter((line) => line.direction === shortDirection);
    const target = candidates.reduce((largest, line) =>
      line.amountMinor > largest.amountMinor ? line : largest,
    );
    target.baseAmountMinor += baseDiff > 0n ? baseDiff : -baseDiff;
  }

  assertBalanced(lines);
  return lines;
}

/** The ledger's iron rule: debits must equal credits, in both original and base currency. */
export function assertBalanced(lines: DraftJournalLine[]): void {
  if (lines.length < 2) {
    throw new LedgerError('A transaction needs at least two journal lines.');
  }

  const pick = (direction: Direction, field: 'amountMinor' | 'baseAmountMinor') =>
    sumMinor(lines.filter((line) => line.direction === direction).map((line) => line[field]));

  if (pick('debit', 'amountMinor') !== pick('credit', 'amountMinor')) {
    throw new LedgerError('Journal lines are not balanced in transaction currency.');
  }
  if (pick('debit', 'baseAmountMinor') !== pick('credit', 'baseAmountMinor')) {
    throw new LedgerError('Journal lines are not balanced in base currency.');
  }
}

export type LineInvariantContext = {
  currency: string;
  baseCurrency: string;
  scaledRate: bigint;
  rateSource: RateSource;
};

/**
 * 行级不变量。数据库的配平触发器只比较借贷两边的合计，
 * 两边错得一样多可以通过，因此必须在行级另行断言。
 *
 * I3：每行的 baseAmountMinor 必须与所记汇率自洽，只允许 buildLines 那一次
 *     舍入吸收造成的偏离——最多一行、且这一行的偏离必须正好等于两边的残差。
 * I4：外币交易的汇率不得恰好为 1，除非用户手工输入了 1。
 *
 * I4 检查的是汇率本身而不是两个金额是否相等：小数位不同的币种对
 * （JPY 到 MYR、汇率 0.01）转换后可以合法地得到相同的数值。
 *
 * I3 为什么不是「每行都必须等于自己的 convertToBaseMinor」：
 *
 * 那才是这个函数原来的写法，而它与 buildLines 互斥。buildLines 逐行独立换算
 * 之后，两边的本位币合计可能差几个最小单位（每行各自舍入，误差不抵消），
 * 它按会计惯例把这个残差吸收进短边最大的那一行——也就是故意让那一行不等于
 * 自己的 convertToBaseMinor。post-journal.ts 里这两个函数是背靠背调用的：
 * 上一句刚制造出偏离，下一句就以任何偏离为由抛错。今天碰不到，只是因为四个
 * 模板都恰好出两行同额分录，残差恒为 0；第一笔三行外币事件（阶段 4 的发票、
 * 资产处置）会在自己的边界上撞出一条假的 I3 错误，而不是记账成功。
 *
 * 现在这三条合起来说的是吸收之后真正成立的事，而不是一个放宽的容差：
 *
 *   1. 至多一行偏离自己的 convertToBaseMinor；
 *   2. 那一行的偏离幅度不超过 n - 1 个最小单位（n 为行数）。逐行半进位的
 *      误差各在 (-0.5, 0.5]，n 行合起来的残差绝对值必然小于 n/2，n - 1 是
 *      一个保守的上界；
 *   3. 借方 baseAmountMinor 合计等于贷方合计。
 *
 * 第 3 条是关键：它把第 1 条里那一行的偏离量钉死成「正好等于逐行换算后的
 * 残差」这一个值，而不是给了它 n - 1 的活动空间。换句话说，一个真的算错了
 * 的换算通不过——错在所有行上被第 1 条挡住，只错一行则会让两边合计不等，
 * 被第 3 条挡住。这个函数自己重算 convertToBaseMinor，不读 buildLines 递过来
 * 的任何声明，所以它检的仍然是结果本身。
 *
 * 它不检查被吸收的是不是「短边最大的那一行」：落在哪一行是 buildLines 的
 * 会计惯例，不是分录的正确性条件，由 tests/domain/ledger-nline.test.ts 钉住。
 */
export function assertLineInvariants(
  lines: DraftJournalLine[],
  ctx: LineInvariantContext,
): void {
  const { currency, baseCurrency, scaledRate, rateSource } = ctx;

  if (currency !== baseCurrency && scaledRate === RATE_SCALE && rateSource !== 'manual') {
    throw new LedgerError(
      `Refusing to record ${currency} against base ${baseCurrency} at an automatic rate of exactly 1. ` +
        'Resolve a real rate or record the rate as manual.',
    );
  }

  const deviations = lines.flatMap((line) => {
    const expected = convertToBaseMinor({
      amountMinor: line.amountMinor,
      currency,
      baseCurrency,
      scaledRate,
    });
    return line.baseAmountMinor === expected ? [] : [{ line, expected }];
  });

  const describe = (entry: { line: DraftJournalLine; expected: bigint }) =>
    `account ${entry.line.accountId} records base amount ${entry.line.baseAmountMinor}, ` +
    `but ${entry.line.amountMinor} ${currency} at the recorded rate converts to ` +
    `${entry.expected} ${baseCurrency}`;

  if (deviations.length > 1) {
    throw new LedgerError(
      `${deviations.length} journal lines disagree with the recorded rate; at most one may absorb ` +
        `the rounding residual. ${deviations.map(describe).join('; ')}.`,
    );
  }

  if (deviations.length === 1) {
    const [deviation] = deviations;
    const drift = deviation.line.baseAmountMinor - deviation.expected;
    const magnitude = drift < 0n ? -drift : drift;
    // 残差只可能来自逐行舍入，绝对值小于行数的一半；n - 1 是保守上界。
    const limit = BigInt(lines.length - 1);
    if (magnitude > limit) {
      throw new LedgerError(
        `Journal line on ${describe(deviation)}. Rounding may move at most ${limit} minor unit(s).`,
      );
    }
  }

  // 借贷两边的本位币合计必须相等。这一条把上面那一行的偏离量钉死：吸收残差
  // 之外的任何改动都会让两边不等。assertBalanced 另外还管原币那一边。
  const baseByDirection = (direction: Direction) =>
    sumMinor(lines.filter((line) => line.direction === direction).map((line) => line.baseAmountMinor));

  if (baseByDirection('debit') !== baseByDirection('credit')) {
    throw new LedgerError('Journal lines are not balanced in base currency.');
  }
}
