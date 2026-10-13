/**
 * 发票的版式选项（0036）。设置页、校验、仓储与打印页共用这一份取值，
 * 与数据库上的两条 CHECK 一一对应。
 */

/**
 * 发票打印语言。与操作员的界面语言无关：发票是给客户看的。
 * bilingual 是英文为主、中文并列——马来西亚华人商家很常见的那种单据。
 */
export const INVOICE_LOCALES = ['en', 'zh', 'bilingual'] as const;
export type InvoiceLocale = (typeof INVOICE_LOCALES)[number];

/**
 * 发票底部。有的公司要签名盖章，有的只要一句「电脑生成、无需签名」，
 * 有的什么都不要——三种都是正常做法，由公司自己选。
 */
export const INVOICE_SIGNOFFS = ['computer_generated', 'signature', 'none'] as const;
export type InvoiceSignoff = (typeof INVOICE_SIGNOFFS)[number];

export function isInvoiceLocale(value: unknown): value is InvoiceLocale {
  return typeof value === 'string' && (INVOICE_LOCALES as readonly string[]).includes(value);
}

export function isInvoiceSignoff(value: unknown): value is InvoiceSignoff {
  return typeof value === 'string' && (INVOICE_SIGNOFFS as readonly string[]).includes(value);
}

/** 客户参考号（PO 号）的长度上限。服务端与表单共用。 */
export const MAX_INVOICE_REFERENCE_LENGTH = 60;

/**
 * 语言选项的名字。每种语言用它自己的文字写，不随界面翻译：找「中文」的人
 * 认得的是「中文」两个字，不是 Chinese。
 */
export const INVOICE_LOCALE_NAMES: Record<InvoiceLocale, string> = {
  en: 'English',
  zh: '中文',
  bilingual: 'English + 中文',
};
