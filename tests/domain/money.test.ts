import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  addMinor,
  currencyExponent,
  formatMinorToDecimal,
  parseDecimalToMinor,
  sumMinor,
} from '@/server/domain/money';

describe('currencyExponent', () => {
  it('returns 2 for common currencies', () => {
    expect(currencyExponent('MYR')).toBe(2);
    expect(currencyExponent('SGD')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('CNY')).toBe(2);
  });

  it('returns 0 for zero-decimal currencies', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('VND')).toBe(0);
  });

  it('rejects malformed currency codes', () => {
    expect(() => currencyExponent('myr')).toThrow(MoneyError);
    expect(() => currencyExponent('MYRR')).toThrow(MoneyError);
  });
});

describe('parseDecimalToMinor', () => {
  it('parses plain decimals without floating point error', () => {
    expect(parseDecimalToMinor('1200.55', 2)).toBe(1200_55n);
    expect(parseDecimalToMinor('0.1', 2)).toBe(10n);
    expect(parseDecimalToMinor('1234', 2)).toBe(123400n);
  });

  it('handles the classic 0.1 + 0.2 case exactly', () => {
    const total = addMinor(parseDecimalToMinor('0.1', 2), parseDecimalToMinor('0.2', 2));
    expect(formatMinorToDecimal(total, 2)).toBe('0.30');
  });

  it('accepts thousands separators and surrounding spaces', () => {
    expect(parseDecimalToMinor(' 1,234.50 ', 2)).toBe(123450n);
  });

  it('parses zero-exponent currencies', () => {
    expect(parseDecimalToMinor('5000', 0)).toBe(5000n);
  });

  it('rejects more decimal places than the currency allows', () => {
    expect(() => parseDecimalToMinor('1.005', 2)).toThrow(MoneyError);
    expect(() => parseDecimalToMinor('5000.5', 0)).toThrow(MoneyError);
  });

  it('rejects negative and non-numeric input', () => {
    expect(() => parseDecimalToMinor('-5.00', 2)).toThrow(MoneyError);
    expect(() => parseDecimalToMinor('abc', 2)).toThrow(MoneyError);
    expect(() => parseDecimalToMinor('', 2)).toThrow(MoneyError);
  });
});

describe('formatMinorToDecimal', () => {
  it('pads fractional digits', () => {
    expect(formatMinorToDecimal(5n, 2)).toBe('0.05');
    expect(formatMinorToDecimal(500n, 2)).toBe('5.00');
    expect(formatMinorToDecimal(0n, 2)).toBe('0.00');
  });

  it('omits the decimal point for zero-exponent currencies', () => {
    expect(formatMinorToDecimal(5000n, 0)).toBe('5000');
  });

  it('round-trips through parseDecimalToMinor', () => {
    expect(formatMinorToDecimal(parseDecimalToMinor('98765.43', 2), 2)).toBe('98765.43');
  });
});

describe('sumMinor', () => {
  it('sums an empty list to zero', () => {
    expect(sumMinor([])).toBe(0n);
  });

  it('sums large values without precision loss', () => {
    const big = 90_071_992_547_409_91n;
    expect(sumMinor([big, big])).toBe(big * 2n);
  });
});
