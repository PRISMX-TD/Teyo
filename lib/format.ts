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

/**
 * 不带币种符号的金额：1,000.00。按币种的小数位，不是一律两位。
 *
 * 发票明细行用它：每一格都印「US$」，读的人要在一列符号里找数字。币种在
 * 单据抬头写一次、合计那一行再带一次符号，就够了。
 */
export function formatAmount(amountMinor: bigint, currency: string): string {
  const decimal = formatMinorToDecimal(amountMinor, currencyExponent(currency));
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [whole, fraction] = unsigned.split('.');
  const grouped = groupThousands(whole);
  return `${negative ? '-' : ''}${fraction ? `${grouped}.${fraction}` : grouped}`;
}

export function formatMoney(amountMinor: bigint, currency: string, _locale?: Locale): string {
  const amount = formatAmount(amountMinor, currency);
  const negative = amount.startsWith('-');
  const symbol = SYMBOLS[currency] ?? currency;
  return `${negative ? '-' : ''}${symbol} ${negative ? amount.slice(1) : amount}`;
}

/**
 * 数量去掉多余的零：数据库是 numeric(12,4)，读出来永远是 '1.0000'。
 * '1.0000' → '1'，'2.5000' → '2.5'，'1200.0000' → '1,200'。
 *
 * 只动字符串，不经 Number()：数量会和单价相乘出金额，这个仓库里任何一处
 * 让数量先变成浮点的写法，迟早有人照着抄到算钱的地方去。
 */
export function formatQuantity(quantity: string): string {
  const trimmed = quantity.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole, fraction = ''] = unsigned.split('.');
  const kept = fraction.replace(/0+$/, '');
  const body = `${groupThousands(whole || '0')}${kept ? `.${kept}` : ''}`;
  return negative ? `-${body}` : body;
}

/**
 * 单据上的日期：英文 13 Oct 2026，中文 2026年10月13日。
 *
 * 入参是 YYYY-MM-DD（date 列，没有时区）。直接拆字符串拼，不经 Date：这一天
 * 在哪个时区打印都是这一天——toIsoDate 上面那条注释说的就是经过 Date 之后
 * 退一天的那个坑。认不出的格式原样返回，宁可难看也不印错一天。
 */
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDocumentDate(isoDate: string, locale: Locale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return isoDate;
  // 英文月份自己拼，不交给 Intl：新版 ICU 的 en-GB 把九月缩写成「Sept」，
  // 别的月份都是三个字母，一张单据上会出现两种写法，且随运行环境而变。
  if (locale !== 'zh') return `${day} ${EN_MONTHS[month - 1]} ${year}`;
  return `${year}年${month}月${day}日`;
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
