import { describe, expect, it } from 'vitest';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import { LedgerError, assertBalanced, buildLines } from '@/server/domain/ledger';

const A = 'acc-a';
const B = 'acc-b';
const C = 'acc-c';

describe('buildLines - n lines', () => {
  it('builds a three-line invoice shape and balances', () => {
    const lines = buildLines(
      [
        { accountId: A, direction: 'debit', amountMinor: 10600n },
        { accountId: B, direction: 'credit', amountMinor: 10000n },
        { accountId: C, direction: 'credit', amountMinor: 600n },
      ],
      { currency: 'MYR', baseCurrency: 'MYR', scaledRate: RATE_SCALE },
    );

    expect(lines).toHaveLength(3);
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('rejects specs that do not balance in the original currency', () => {
    expect(() =>
      buildLines(
        [
          { accountId: A, direction: 'debit', amountMinor: 10000n },
          { accountId: B, direction: 'credit', amountMinor: 9999n },
        ],
        { currency: 'MYR', baseCurrency: 'MYR', scaledRate: RATE_SCALE },
      ),
    ).toThrow(LedgerError);
  });

  it('rejects fewer than two lines', () => {
    expect(() =>
      buildLines([{ accountId: A, direction: 'debit', amountMinor: 100n }], {
        currency: 'MYR',
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
      }),
    ).toThrow(LedgerError);
  });

  it('absorbs a rounding difference into the largest line, keeping base amounts balanced', () => {
    // Debit 5, credits 3 (largest, listed FIRST) and 2 (smaller, listed LAST).
    // Independent per-line conversion at this rate gives debit -> 24,
    // credit B(3) -> 14, credit C(2) -> 9. Credits sum to 23 against a debit
    // of 24: a genuine one-cent gap on the credit side. B is both the
    // largest credit line and NOT the last line in the specs array, so this
    // input can distinguish "adjust the largest line" from "adjust the last
    // line" -- an input where the largest line happens to also be last
    // cannot tell the two apart.
    const lines = buildLines(
      [
        { accountId: A, direction: 'debit', amountMinor: 5n },
        { accountId: B, direction: 'credit', amountMinor: 3n },
        { accountId: C, direction: 'credit', amountMinor: 2n },
      ],
      { currency: 'USD', baseCurrency: 'MYR', scaledRate: 4_71834900n },
    );

    expect(() => assertBalanced(lines)).not.toThrow();

    const debit = lines.find((l) => l.accountId === A)!;
    const largestCredit = lines.find((l) => l.accountId === B)!;
    const otherCredit = lines.find((l) => l.accountId === C)!;

    const exact = (amount: bigint) => (amount * 4_71834900n * 2n + RATE_SCALE) / (RATE_SCALE * 2n);

    // The debit side was already balanced on its own; its single line is untouched.
    expect(debit.baseAmountMinor).toBe(exact(5n));
    // The smaller, last-listed credit line equals its own independent conversion.
    expect(otherCredit.baseAmountMinor).toBe(exact(2n));
    // The larger, first-listed credit line absorbs the one-cent gap.
    expect(largestCredit.baseAmountMinor).toBe(exact(3n) + 1n);
  });

  it('preserves every line-level invariant that assertLineInvariants would check, except on the adjusted line', () => {
    const lines = buildLines(
      [
        { accountId: A, direction: 'debit', amountMinor: 100n },
        { accountId: B, direction: 'credit', amountMinor: 100n },
      ],
      { currency: 'SGD', baseCurrency: 'MYR', scaledRate: 3_50000000n },
    );
    expect(lines[0].baseAmountMinor).toBe(350n);
    expect(lines[1].baseAmountMinor).toBe(350n);
  });
});
