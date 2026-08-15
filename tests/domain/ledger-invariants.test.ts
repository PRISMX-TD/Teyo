import { describe, expect, it } from 'vitest';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import {
  LedgerError,
  assertLineInvariants,
  buildJournalLines,
  type DraftJournalLine,
} from '@/server/domain/ledger';

const BANK = 'account-bank';
const SALES = 'account-sales';

describe('assertLineInvariants - I3 base amount consistency', () => {
  it('accepts lines produced by buildJournalLines', () => {
    const lines = buildJournalLines({
      kind: 'income',
      amountMinor: 10000n,
      currency: 'SGD',
      baseCurrency: 'MYR',
      scaledRate: 3_50000000n,
      moneyAccountId: BANK,
      counterAccountId: SALES,
    });

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'SGD',
        baseCurrency: 'MYR',
        scaledRate: 3_50000000n,
        rateSource: 'auto',
      }),
    ).not.toThrow();
  });

  it('rejects a line whose base amount does not match the recorded rate', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 10000n, baseAmountMinor: 34000n },
      { accountId: SALES, direction: 'credit', amountMinor: 10000n, baseAmountMinor: 34000n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'SGD',
        baseCurrency: 'MYR',
        scaledRate: 3_50000000n,
        rateSource: 'auto',
      }),
    ).toThrow(LedgerError);
  });
});

describe('assertLineInvariants - I4 fabricated 1:1 rate', () => {
  it('rejects a foreign-currency posting recorded at an auto rate of exactly 1', () => {
    // 这正是 server/actions/recurring.ts 当前产生的形状：
    // base = amount 且 scaledRate = 1.0，两者自洽，I3 抓不到。
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 50000n, baseAmountMinor: 50000n },
      { accountId: SALES, direction: 'credit', amountMinor: 50000n, baseAmountMinor: 50000n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'USD',
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
        rateSource: 'auto',
      }),
    ).toThrow(LedgerError);
  });

  it('allows a rate of exactly 1 when the user entered it manually', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 50000n, baseAmountMinor: 50000n },
      { accountId: SALES, direction: 'credit', amountMinor: 50000n, baseAmountMinor: 50000n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'USD',
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
        rateSource: 'manual',
      }),
    ).not.toThrow();
  });

  it('allows a rate of exactly 1 for a domestic posting', () => {
    const lines = buildJournalLines({
      kind: 'income',
      amountMinor: 50000n,
      currency: 'MYR',
      baseCurrency: 'MYR',
      scaledRate: RATE_SCALE,
      moneyAccountId: BANK,
      counterAccountId: SALES,
    });

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'MYR',
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
        rateSource: 'auto',
      }),
    ).not.toThrow();
  });

  it('does not false-positive when conversion legitimately preserves the number', () => {
    // JPY 小数位为 0，MYR 为 2。JPY 100 在汇率 0.01 下 = MYR 1.00 = 100 minor。
    // 金额相等但汇率不是 1，属于合法情形。
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 100n, baseAmountMinor: 100n },
      { accountId: SALES, direction: 'credit', amountMinor: 100n, baseAmountMinor: 100n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'JPY',
        baseCurrency: 'MYR',
        scaledRate: 1000000n, // 0.01
        rateSource: 'auto',
      }),
    ).not.toThrow();
  });
});

describe('assertLineInvariants - property sweep', () => {
  const PAIRS: [string, string][] = [
    ['MYR', 'MYR'], ['SGD', 'MYR'], ['USD', 'MYR'],
    ['JPY', 'MYR'], ['MYR', 'JPY'], ['USD', 'SGD'],
  ];
  const RATES = [RATE_SCALE, 3_50000000n, 4_71834900n, 1000000n, 25_00000000n];

  it('every buildJournalLines output satisfies I3 and I4', () => {
    for (const [currency, baseCurrency] of PAIRS) {
      for (const scaledRate of RATES) {
        if (currency === baseCurrency && scaledRate !== RATE_SCALE) continue;
        for (const amountMinor of [1n, 7n, 999n, 100000n, 123456789n]) {
          const lines = buildJournalLines({
            kind: 'income',
            amountMinor,
            currency,
            baseCurrency,
            scaledRate,
            moneyAccountId: BANK,
            counterAccountId: SALES,
          });

          const rateSource = currency !== baseCurrency && scaledRate === RATE_SCALE
            ? 'manual'
            : 'auto';

          expect(() =>
            assertLineInvariants(lines, { currency, baseCurrency, scaledRate, rateSource }),
          ).not.toThrow();
        }
      }
    }
  });
});
