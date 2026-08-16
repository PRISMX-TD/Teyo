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
    // 三行外币，逐行换算会产生一分的取整差。
    const lines = buildLines(
      [
        { accountId: A, direction: 'debit', amountMinor: 10000n },
        { accountId: B, direction: 'credit', amountMinor: 3333n },
        { accountId: C, direction: 'credit', amountMinor: 6667n },
      ],
      { currency: 'USD', baseCurrency: 'MYR', scaledRate: 4_71834900n },
    );

    expect(() => assertBalanced(lines)).not.toThrow();

    // 差额必须落在金额最大的那一行，不是最后一行
    const debit = lines.find((l) => l.direction === 'debit')!;
    const credits = lines.filter((l) => l.direction === 'credit');
    const largestCredit = credits.reduce((a, b) => (b.amountMinor > a.amountMinor ? b : a));
    const otherCredit = credits.find((l) => l !== largestCredit)!;

    // 未被调整的那一行必须等于它自己的独立换算值
    const exact = (amount: bigint) => (amount * 4_71834900n * 2n + RATE_SCALE) / (RATE_SCALE * 2n);
    expect(otherCredit.baseAmountMinor).toBe(exact(otherCredit.amountMinor));
    expect(debit.baseAmountMinor).toBe(exact(debit.amountMinor));
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
