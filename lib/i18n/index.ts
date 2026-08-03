import en from '@/lib/i18n/en';
import zh from '@/lib/i18n/zh';

export type Locale = 'en' | 'zh';

/**
 * en.ts 带 as const，直接用 `typeof en` 会把每个文案窄化成字面量类型，
 * 消费方拿到的会是 'Sign in' 这种类型而不是 string。这里放宽叶子节点，
 * 键名结构照旧受约束。
 */
type Widen<T> = {
  [K in keyof T]: T[K] extends string ? string : Widen<T[K]>;
};

export type Messages = Widen<typeof en>;

export const LOCALES: readonly Locale[] = ['en', 'zh'] as const;
export const DEFAULT_LOCALE: Locale = 'en';

const CATALOGS: Record<Locale, Messages> = { en, zh };

export function getMessages(locale: Locale): Messages {
  return CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** 双语字段取值：优先当前语言，缺失时回退到另一种。 */
export function localizedName(
  row: { name_en: string | null; name_zh: string | null },
  locale: Locale,
): string {
  const preferred = locale === 'zh' ? row.name_zh : row.name_en;
  const fallback = locale === 'zh' ? row.name_en : row.name_zh;
  return preferred?.trim() || fallback?.trim() || '';
}

/** 把 '{org} invited you' 这类占位符替换掉。 */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    key in values ? String(values[key]) : `{${key}}`,
  );
}
