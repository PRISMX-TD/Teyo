import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  formatMinorToDecimal,
  parseDecimalToMinor,
} from '@/server/domain/money';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

const AMOUNTS = [0n, 1n, 7n, 99n, 100n, 12345n, 999999999n, 123456789012n];

describe('money round-trip', () => {
  it('parse(format(n)) === n for every supported currency', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const exponent = currencyExponent(currency);
      for (const amountMinor of AMOUNTS) {
        const formatted = formatMinorToDecimal(amountMinor, exponent);
        expect(
          parseDecimalToMinor(formatted, exponent),
          `${currency} (exponent ${exponent}) failed at ${amountMinor}`,
        ).toBe(amountMinor);
      }
    }
  });

  it('zero-decimal currencies never gain a decimal point', () => {
    expect(formatMinorToDecimal(100n, currencyExponent('JPY'))).toBe('100');
    expect(formatMinorToDecimal(100n, currencyExponent('MYR'))).toBe('1.00');
  });

  it('dividing minor units by 100 corrupts zero-decimal currencies', () => {
    // 这是 transactions/[id]/page.tsx 当前的做法，记录下它为什么必须改。
    const jpyMinor = 1000n; // ¥1000
    const naive = (Number(jpyMinor) / 100).toString(); // "10"
    const correct = formatMinorToDecimal(jpyMinor, currencyExponent('JPY')); // "1000"
    expect(naive).not.toBe(correct);
    expect(correct).toBe('1000');
  });
});
