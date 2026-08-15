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

export type BuildLinesInput = {
  kind: TransactionKind;
  amountMinor: bigint;
  currency: string;
  baseCurrency: string;
  scaledRate: bigint;
  /** Income: destination. Expense: source of funds. Transfer: destination. */
  moneyAccountId: string;
  /** Income: revenue account. Expense: expense account. Transfer: source account. */
  counterAccountId: string;
};

/**
 * Maps a user-facing operation onto a balanced pair of journal lines.
 *
 * income   debit money account   / credit revenue account
 * expense  debit expense account / credit money account
 * transfer debit destination     / credit source
 * journal  debit account         / credit account
 */
export function buildJournalLines(input: BuildLinesInput): DraftJournalLine[] {
  const { kind, amountMinor, currency, baseCurrency, scaledRate, moneyAccountId, counterAccountId } =
    input;

  if (amountMinor <= 0n) {
    throw new LedgerError('Transaction amount must be greater than zero.');
  }
  if (scaledRate <= 0n) {
    throw new LedgerError('Exchange rate must be greater than zero.');
  }
  if (!moneyAccountId || !counterAccountId) {
    throw new LedgerError('Both accounts are required.');
  }
  if ((kind === 'transfer' || kind === 'journal') && moneyAccountId === counterAccountId) {
    throw new LedgerError('This operation requires two different accounts.');
  }

  const baseAmountMinor = convertToBaseMinor({
    amountMinor,
    currency,
    baseCurrency,
    scaledRate,
  });

  // journal: debit moneyAccountId, credit counterAccountId (same as income)
  const debitAccountId = (kind === 'expense') ? counterAccountId : moneyAccountId;
  const creditAccountId = (kind === 'expense') ? moneyAccountId : counterAccountId;

  const lines: DraftJournalLine[] = [
    { accountId: debitAccountId, direction: 'debit', amountMinor, baseAmountMinor },
    { accountId: creditAccountId, direction: 'credit', amountMinor, baseAmountMinor },
  ];

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
 * I3：每行的 baseAmountMinor 必须与所记汇率自洽。
 * I4：外币交易的汇率不得恰好为 1，除非用户手工输入了 1。
 *
 * I4 检查的是汇率本身而不是两个金额是否相等：小数位不同的币种对
 * （JPY 到 MYR、汇率 0.01）转换后可以合法地得到相同的数值。
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

  for (const line of lines) {
    const expected = convertToBaseMinor({
      amountMinor: line.amountMinor,
      currency,
      baseCurrency,
      scaledRate,
    });

    if (line.baseAmountMinor !== expected) {
      throw new LedgerError(
        `Journal line on account ${line.accountId} records base amount ${line.baseAmountMinor}, ` +
          `but ${line.amountMinor} ${currency} at the recorded rate converts to ${expected} ${baseCurrency}.`,
      );
    }
  }
}
