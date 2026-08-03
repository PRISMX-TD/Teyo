import { describe, expect, it } from 'vitest';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import {
  LedgerError,
  assertBalanced,
  buildJournalLines,
  type DraftJournalLine,
} from '@/server/domain/ledger';

const BANK = 'account-bank';
const CASH = 'account-cash';
const SALES = 'account-sales';
const RENT = 'account-rent';

function baseInput() {
  return {
    amountMinor: 50000n,
    currency: 'MYR',
    baseCurrency: 'MYR',
    scaledRate: RATE_SCALE,
    moneyAccountId: BANK,
    counterAccountId: SALES,
  };
}

describe('buildJournalLines - income', () => {
  it('debits the money account and credits the revenue account', () => {
    const lines = buildJournalLines({ ...baseInput(), kind: 'income' });

    expect(lines).toHaveLength(2);
    expect(lines).toEqual([
      { accountId: BANK, direction: 'debit', amountMinor: 50000n, baseAmountMinor: 50000n },
      { accountId: SALES, direction: 'credit', amountMinor: 50000n, baseAmountMinor: 50000n },
    ]);
  });
});

describe('buildJournalLines - expense', () => {
  it('debits the expense account and credits the money account', () => {
    const lines = buildJournalLines({
      ...baseInput(),
      kind: 'expense',
      amountMinor: 120000n,
      moneyAccountId: CASH,
      counterAccountId: RENT,
    });

    expect(lines).toEqual([
      { accountId: RENT, direction: 'debit', amountMinor: 120000n, baseAmountMinor: 120000n },
      { accountId: CASH, direction: 'credit', amountMinor: 120000n, baseAmountMinor: 120000n },
    ]);
  });
});

describe('buildJournalLines - transfer', () => {
  it('debits the destination account and credits the source account', () => {
    const lines = buildJournalLines({
      ...baseInput(),
      kind: 'transfer',
      amountMinor: 80000n,
      moneyAccountId: BANK,
      counterAccountId: CASH,
    });

    expect(lines).toEqual([
      { accountId: BANK, direction: 'debit', amountMinor: 80000n, baseAmountMinor: 80000n },
      { accountId: CASH, direction: 'credit', amountMinor: 80000n, baseAmountMinor: 80000n },
    ]);
  });

  it('rejects a transfer between the same account', () => {
    expect(() =>
      buildJournalLines({
        ...baseInput(),
        kind: 'transfer',
        moneyAccountId: BANK,
        counterAccountId: BANK,
      }),
    ).toThrow(LedgerError);
  });
});

describe('buildJournalLines - foreign currency', () => {
  it('records the original amount on both lines and the converted base amount', () => {
    // 100.00 SGD at 3.5 MYR/SGD = 350.00 MYR
    const lines = buildJournalLines({
      kind: 'income',
      amountMinor: 10000n,
      currency: 'SGD',
      baseCurrency: 'MYR',
      scaledRate: 3_50000000n,
      moneyAccountId: BANK,
      counterAccountId: SALES,
    });

    expect(lines[0]).toEqual({
      accountId: BANK,
      direction: 'debit',
      amountMinor: 10000n,
      baseAmountMinor: 35000n,
    });
    expect(lines[1]).toEqual({
      accountId: SALES,
      direction: 'credit',
      amountMinor: 10000n,
      baseAmountMinor: 35000n,
    });
  });

  it('keeps both sides balanced in base currency after rounding', () => {
    const lines = buildJournalLines({
      kind: 'expense',
      amountMinor: 3333n,
      currency: 'USD',
      baseCurrency: 'MYR',
      scaledRate: 4_71834900n,
      moneyAccountId: CASH,
      counterAccountId: RENT,
    });

    expect(() => assertBalanced(lines)).not.toThrow();
  });
});

describe('buildJournalLines - validation', () => {
  it('rejects a zero or negative amount', () => {
    expect(() => buildJournalLines({ ...baseInput(), kind: 'income', amountMinor: 0n })).toThrow(
      LedgerError,
    );
    expect(() => buildJournalLines({ ...baseInput(), kind: 'income', amountMinor: -1n })).toThrow(
      LedgerError,
    );
  });

  it('rejects a non-positive exchange rate', () => {
    expect(() => buildJournalLines({ ...baseInput(), kind: 'income', scaledRate: 0n })).toThrow(
      LedgerError,
    );
  });

  it('always produces balanced lines for every kind', () => {
    for (const kind of ['income', 'expense', 'transfer'] as const) {
      const lines = buildJournalLines({
        ...baseInput(),
        kind,
        counterAccountId: kind === 'transfer' ? CASH : SALES,
      });
      expect(() => assertBalanced(lines)).not.toThrow();
    }
  });
});

describe('assertBalanced', () => {
  it('accepts lines whose debits equal credits', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 100n, baseAmountMinor: 100n },
      { accountId: SALES, direction: 'credit', amountMinor: 60n, baseAmountMinor: 60n },
      { accountId: RENT, direction: 'credit', amountMinor: 40n, baseAmountMinor: 40n },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('rejects unbalanced original amounts', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 100n, baseAmountMinor: 100n },
      { accountId: SALES, direction: 'credit', amountMinor: 99n, baseAmountMinor: 100n },
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerError);
  });

  it('rejects unbalanced base amounts even when original amounts balance', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 100n, baseAmountMinor: 350n },
      { accountId: SALES, direction: 'credit', amountMinor: 100n, baseAmountMinor: 349n },
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerError);
  });

  it('rejects fewer than two lines', () => {
    expect(() => assertBalanced([])).toThrow(LedgerError);
    expect(() =>
      assertBalanced([
        { accountId: BANK, direction: 'debit', amountMinor: 0n, baseAmountMinor: 0n },
      ]),
    ).toThrow(LedgerError);
  });
});
