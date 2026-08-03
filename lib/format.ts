import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import type { Locale } from '@/lib/i18n';

const SYMBOLS: Record<string, string> = {
  MYR: 'RM',
  SGD: 'S$',
  USD: 'US$',
  CNY: '¥',
};

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatMoney(amountMinor: bigint, currency: string, _locale: Locale): string {
  const exponent = currencyExponent(currency);
  const decimal = formatMinorToDecimal(amountMinor, exponent);
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole, fraction] = unsigned.split('.');
  const grouped = groupThousands(whole);
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  const symbol = SYMBOLS[currency] ?? currency;
  return `${negative ? '-' : ''}${symbol} ${body}`;
}

/**
 * 数据库 date 列转成 YYYY-MM-DD。
 *
 * 用本地日期部分，不能用 getUTC* 或 toISOString()：postgres.js 把 date 列解析成
 * 本地午夜的 Date，转 UTC 后在 UTC+8 会退回前一天（2026-03-31 变成 2026-03-30）。
 * 计划原稿在这里用的是 getUTC*，与 Task 10 在 guard.ts 修掉的是同一个坑。
 */
export function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDateTime(value: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(value);
}
