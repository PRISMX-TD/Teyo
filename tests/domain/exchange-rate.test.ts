import { describe, expect, it } from 'vitest';
import { MoneyError, formatMinorToDecimal } from '@/server/domain/money';
import {
  RATE_SCALE,
  convertToBaseMinor,
  formatScaledRate,
  parseRateToScaled,
} from '@/server/domain/exchange-rate';

describe('parseRateToScaled', () => {
  it('scales a rate to 8 decimal places', () => {
    expect(parseRateToScaled('1')).toBe(RATE_SCALE);
    expect(parseRateToScaled('3.4567')).toBe(345_670_000n);
  });

  it('rejects zero, negative and non-numeric rates', () => {
    expect(() => parseRateToScaled('0')).toThrow(MoneyError);
    expect(() => parseRateToScaled('-1.2')).toThrow(MoneyError);
    expect(() => parseRateToScaled('abc')).toThrow(MoneyError);
  });

  it('rejects more than 8 decimal places', () => {
    expect(() => parseRateToScaled('1.123456789')).toThrow(MoneyError);
  });
});

describe('formatScaledRate', () => {
  it('trims trailing zeros but keeps at least two decimals', () => {
    expect(formatScaledRate(RATE_SCALE)).toBe('1.00');
    expect(formatScaledRate(345_670_000n)).toBe('3.4567');
  });
});

describe('convertToBaseMinor', () => {
  it('returns the same amount when currency equals base currency', () => {
    const result = convertToBaseMinor({
      amountMinor: 1200_55n,
      currency: 'MYR',
      baseCurrency: 'MYR',
      scaledRate: RATE_SCALE,
    });
    expect(result).toBe(1200_55n);
  });

  it('converts between two-decimal currencies with half-up rounding', () => {
    // 100.00 SGD at 3.4567 MYR/SGD = 345.67 MYR
    const result = convertToBaseMinor({
      amountMinor: 100_00n,
      currency: 'SGD',
      baseCurrency: 'MYR',
      scaledRate: parseRateToScaled('3.4567'),
    });
    expect(formatMinorToDecimal(result, 2)).toBe('345.67');
  });

  it('rounds half up on the smallest unit', () => {
    // 1.00 USD at 4.005 MYR/USD = 4.005 MYR -> 4.01
    const result = convertToBaseMinor({
      amountMinor: 1_00n,
      currency: 'USD',
      baseCurrency: 'MYR',
      scaledRate: parseRateToScaled('4.005'),
    });
    expect(formatMinorToDecimal(result, 2)).toBe('4.01');
  });

  it('converts across differing currency exponents', () => {
    // 10000 JPY (exponent 0) at 0.03 MYR/JPY = 300.00 MYR (exponent 2)
    const result = convertToBaseMinor({
      amountMinor: 10_000n,
      currency: 'JPY',
      baseCurrency: 'MYR',
      scaledRate: parseRateToScaled('0.03'),
    });
    expect(formatMinorToDecimal(result, 2)).toBe('300.00');
  });

  it('rejects a non-unit rate when currencies match', () => {
    expect(() =>
      convertToBaseMinor({
        amountMinor: 100n,
        currency: 'MYR',
        baseCurrency: 'MYR',
        scaledRate: parseRateToScaled('1.5'),
      }),
    ).toThrow(MoneyError);
  });

  it('rejects a non-positive rate', () => {
    expect(() =>
      convertToBaseMinor({
        amountMinor: 100n,
        currency: 'SGD',
        baseCurrency: 'MYR',
        scaledRate: 0n,
      }),
    ).toThrow(MoneyError);
  });
});
