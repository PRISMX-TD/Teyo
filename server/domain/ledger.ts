import { convertToBaseMinor } from './exchange-rate';
import { sumMinor } from './money';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export type TransactionKind = 'income' | 'expense' | 'transfer';
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
  if (kind === 'transfer' && moneyAccountId === counterAccountId) {
    throw new LedgerError('A transfer requires two different accounts.');
  }

  const baseAmountMinor = convertToBaseMinor({
    amountMinor,
    currency,
    baseCurrency,
    scaledRate,
  });

  const debitAccountId = kind === 'expense' ? counterAccountId : moneyAccountId;
  const creditAccountId = kind === 'expense' ? moneyAccountId : counterAccountId;

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
