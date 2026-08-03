import { describe, expect, it } from 'vitest';
import { getMessages, localizedName, interpolate, isLocale, LOCALES } from '@/lib/i18n';
import { formatMoney, toIsoDate } from '@/lib/format';
import en from '@/lib/i18n/en';
import zh from '@/lib/i18n/zh';

function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function valueAt(catalog: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], catalog);
}

describe('message catalogs', () => {
  it('has identical keys in both locales', () => {
    expect(flatten(zh).sort()).toEqual(flatten(en).sort());
  });

  it('returns the requested catalog', () => {
    expect(getMessages('en').brand.tagline).toBe(en.brand.tagline);
    expect(getMessages('zh').brand.tagline).toBe(zh.brand.tagline);
  });

  it('has no empty strings', () => {
    for (const catalog of [en, zh]) {
      for (const key of flatten(catalog)) {
        expect(valueAt(catalog, key), key).not.toBe('');
      }
    }
  });

  it('keeps the same placeholders in both locales', () => {
    // 漏掉占位符会让界面直接显示 {org} 这种原文，翻译时最容易出这种错。
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();

    for (const key of flatten(en)) {
      const source = valueAt(en, key) as string;
      const target = valueAt(zh, key) as string;
      expect(placeholders(target), key).toEqual(placeholders(source));
    }
  });
});

describe('isLocale', () => {
  it('accepts supported locales and rejects anything else', () => {
    expect(LOCALES).toEqual(['en', 'zh']);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('zh')).toBe(true);
    expect(isLocale('ms')).toBe(false);
    expect(isLocale('')).toBe(false);
  });
});

describe('localizedName', () => {
  it('prefers the requested locale', () => {
    expect(localizedName({ name_en: 'Rent', name_zh: '租金' }, 'zh')).toBe('租金');
    expect(localizedName({ name_en: 'Rent', name_zh: '租金' }, 'en')).toBe('Rent');
  });

  it('falls back to the other locale when one side is missing', () => {
    expect(localizedName({ name_en: 'Rent', name_zh: null }, 'zh')).toBe('Rent');
    expect(localizedName({ name_en: null, name_zh: '租金' }, 'en')).toBe('租金');
  });

  it('treats a blank string as missing', () => {
    expect(localizedName({ name_en: 'Rent', name_zh: '   ' }, 'zh')).toBe('Rent');
    expect(localizedName({ name_en: null, name_zh: null }, 'en')).toBe('');
  });
});

describe('interpolate', () => {
  it('replaces named placeholders', () => {
    expect(interpolate('{org} invited you', { org: 'Acme' })).toBe('Acme invited you');
    expect(interpolate('{count} records', { count: 3 })).toBe('3 records');
  });

  it('leaves unknown placeholders untouched instead of printing undefined', () => {
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
  });
});

describe('formatMoney', () => {
  it('formats minor units with the currency symbol', () => {
    expect(formatMoney(123456n, 'MYR', 'en')).toBe('RM 1,234.56');
    expect(formatMoney(0n, 'MYR', 'en')).toBe('RM 0.00');
  });

  it('formats zero-decimal currencies without a decimal point', () => {
    expect(formatMoney(5000n, 'JPY', 'en')).toBe('JPY 5,000');
  });

  it('groups thousands across large amounts', () => {
    expect(formatMoney(123456789n, 'MYR', 'en')).toBe('RM 1,234,567.89');
    expect(formatMoney(100000n, 'MYR', 'en')).toBe('RM 1,000.00');
  });

  it('keeps the minus sign in front of the symbol', () => {
    expect(formatMoney(-123456n, 'MYR', 'en')).toBe('-RM 1,234.56');
  });

  it('falls back to the code for currencies without a known symbol', () => {
    expect(formatMoney(10000n, 'THB', 'en')).toBe('THB 100.00');
  });
});

describe('toIsoDate', () => {
  it('passes through a date string', () => {
    expect(toIsoDate('2026-03-31')).toBe('2026-03-31');
    expect(toIsoDate('2026-03-31T00:00:00.000Z')).toBe('2026-03-31');
  });

  it('does not shift the day for a local-midnight Date', () => {
    // postgres.js 把 date 列解析成本地午夜。用 UTC 取值会在 UTC+8 下退回前一天，
    // 这与 Task 10 在 guard.ts 修掉的是同一个坑。
    expect(toIsoDate(new Date(2026, 2, 31))).toBe('2026-03-31');
    expect(toIsoDate(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});
