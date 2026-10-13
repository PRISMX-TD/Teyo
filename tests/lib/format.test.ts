import { describe, expect, it } from 'vitest';
import { formatAmount, formatDocumentDate, formatMoney, formatQuantity } from '@/lib/format';

describe('formatAmount', () => {
  it('groups thousands and keeps the currency’s decimals, without a symbol', () => {
    expect(formatAmount(123456789n, 'MYR')).toBe('1,234,567.89');
    expect(formatAmount(1000000n, 'JPY')).toBe('1,000,000');
    expect(formatAmount(-5050n, 'USD')).toBe('-50.50');
  });
});

describe('formatMoney', () => {
  it('still puts the symbol in front, after the minus sign', () => {
    expect(formatMoney(100000n, 'USD')).toBe('US$ 1,000.00');
    expect(formatMoney(-100n, 'MYR')).toBe('-RM 1.00');
    expect(formatMoney(100n, 'EUR')).toBe('EUR 1.00');
  });
});

describe('formatQuantity', () => {
  it('drops the zeros numeric(12,4) pads every quantity with', () => {
    expect(formatQuantity('1.0000')).toBe('1');
    expect(formatQuantity('2.5000')).toBe('2.5');
    expect(formatQuantity('0.1250')).toBe('0.125');
    expect(formatQuantity('1200.0000')).toBe('1,200');
    expect(formatQuantity('3')).toBe('3');
    expect(formatQuantity('-1.5000')).toBe('-1.5');
  });
});

describe('formatDocumentDate', () => {
  it('writes the date in the document’s language', () => {
    expect(formatDocumentDate('2026-10-13', 'en')).toBe('13 Oct 2026');
    expect(formatDocumentDate('2026-10-13', 'zh')).toBe('2026年10月13日');
  });

  it('abbreviates every English month to three letters, September included', () => {
    expect(formatDocumentDate('2026-09-05', 'en')).toBe('5 Sep 2026');
    expect(formatDocumentDate('2026-06-30', 'en')).toBe('30 Jun 2026');
  });

  it('does not slip a day at either end of the year', () => {
    expect(formatDocumentDate('2026-01-01', 'en')).toBe('1 Jan 2026');
    expect(formatDocumentDate('2026-12-31', 'en')).toBe('31 Dec 2026');
  });

  it('returns anything that is not YYYY-MM-DD unchanged', () => {
    expect(formatDocumentDate('13/10/2026', 'en')).toBe('13/10/2026');
  });
});
