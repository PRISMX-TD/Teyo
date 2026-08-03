import ExcelJS from 'exceljs';
import { getMessages, interpolate, localizedName, type Locale } from '@/lib/i18n';
import type { Tx } from '@/server/db/transaction';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import { listTransactions, type TransactionFilters } from '@/server/repositories/transactions';

export type ExportKind = 'transaction-detail' | 'account-summary';
export type ExportFormat = 'csv' | 'xlsx';

/** 一次导出最多这么多行。超过就提示用户缩小期间，避免把服务端内存打满。 */
export const MAX_EXPORT_ROWS = 20000;

/**
 * 导出相关的用户可见错误。只带消息键与占位值，不带成品文案：
 * 抛错的地方在服务端，选语言是调用方的事，硬编码英文会漏给中文用户。
 */
export class ExportError extends Error {
  constructor(
    readonly messageKey: 'exportTooManyRows',
    readonly values: Record<string, string | number>,
  ) {
    super(`${messageKey} ${JSON.stringify(values)}`);
    this.name = 'ExportError';
  }

  localize(locale: Locale): string {
    return interpolate(getMessages(locale).errors[this.messageKey], this.values);
  }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Excel 会把以 = + - @ 开头的单元格当公式执行。说明等字段是用户输入的，
 * 直接写进 CSV 等于把公式注入送给打开文件的人，前面加单引号中和掉。
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvField(value: string): string {
  const safe = neutralizeFormula(value);
  // 含逗号、引号、换行的字段必须加引号，内部引号翻倍
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function buildCsv(headers: string[], rows: string[][]): Buffer {
  const lines = [headers, ...rows].map((row) => row.map(csvField).join(','));
  // Excel 认 CRLF；BOM 让中文在中文版 Excel 里不乱码
  return Buffer.concat([UTF8_BOM, Buffer.from(lines.join('\r\n'), 'utf8')]);
}

export async function buildXlsx(
  sheetName: string,
  headers: string[],
  rows: string[][],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Teyo';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row.map(neutralizeFormula));

  sheet.columns.forEach((column) => {
    let width = 12;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      width = Math.max(width, String(cell.value ?? '').length + 2);
    });
    column.width = Math.min(width, 50);
  });

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/** BASE 是本位币占位符，返回前会替换成公司实际本位币。 */
const DETAIL_HEADERS: Record<Locale, string[]> = {
  en: [
    'Date',
    'Type',
    'Note',
    'Category',
    'Money account',
    'Amount',
    'Currency',
    'Exchange rate',
    'Amount (BASE)',
    'Added by',
    'Attachments',
  ],
  zh: [
    '日期',
    '类型',
    '说明',
    '分类',
    '资金账户',
    '金额',
    '币种',
    '汇率',
    '本位币金额 (BASE)',
    '记录人',
    '附件数',
  ],
};

const KIND_LABELS: Record<Locale, Record<string, string>> = {
  en: { income: 'Money in', expense: 'Money out', transfer: 'Transfer' },
  zh: { income: '收入', expense: '支出', transfer: '转账' },
};

/** 含作废记录时追加的两列：状态与作废原因。 */
const STATUS_HEADERS: Record<Locale, string[]> = {
  en: ['Status', 'Void reason'],
  zh: ['状态', '作废原因'],
};

const VOIDED_LABELS: Record<Locale, string> = { en: 'Voided', zh: '已作废' };

export async function buildTransactionDetailRows(
  tx: Tx,
  organizationId: string,
  filters: TransactionFilters,
  locale: Locale,
): Promise<{ headers: string[]; rows: string[][] }> {
  const [org] = await tx`select base_currency from organizations where id = ${organizationId}`;
  const baseCurrency = org.base_currency as string;
  const baseExponent = currencyExponent(baseCurrency);

  const { rows: transactions, total } = await listTransactions(tx, organizationId, filters, {
    limit: MAX_EXPORT_ROWS,
    offset: 0,
  });

  if (total > MAX_EXPORT_ROWS) {
    throw new ExportError('exportTooManyRows', { count: total, limit: MAX_EXPORT_ROWS });
  }

  const headers = DETAIL_HEADERS[locale].map((h) => h.replace('BASE', baseCurrency));
  if (filters.includeVoided) headers.push(...STATUS_HEADERS[locale]);

  const rows = transactions.map((t) => {
    const row = [
      t.occurredOn,
      KIND_LABELS[locale][t.kind],
      t.description,
      t.categoryId
        ? localizedName({ name_en: t.categoryNameEn, name_zh: t.categoryNameZh }, locale)
        : '',
      t.moneyAccountId
        ? localizedName({ name_en: t.moneyAccountNameEn, name_zh: t.moneyAccountNameZh }, locale)
        : '',
      formatMinorToDecimal(t.amountMinor, currencyExponent(t.currency)),
      t.currency,
      t.exchangeRate,
      formatMinorToDecimal(t.baseAmountMinor, baseExponent),
      t.createdByName,
      String(t.attachmentCount),
    ];

    if (filters.includeVoided) {
      row.push(t.voidedAt ? VOIDED_LABELS[locale] : '', t.voidReason ?? '');
    }
    return row;
  });

  return { headers, rows };
}

const SUMMARY_HEADERS: Record<Locale, string[]> = {
  en: ['Account code', 'Account', 'Type', 'Debit total', 'Credit total', 'Net'],
  zh: ['科目编码', '科目', '类型', '借方合计', '贷方合计', '净额'],
};

const TYPE_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    asset: 'Asset',
    liability: 'Liability',
    equity: 'Equity',
    revenue: 'Revenue',
    expense: 'Expense',
  },
  zh: { asset: '资产', liability: '负债', equity: '权益', revenue: '收入', expense: '费用' },
};

/** 借方性质的科目：资产与费用。其余（负债、权益、收入）是贷方性质。 */
const DEBIT_NATURED = new Set(['asset', 'expense']);

export async function buildAccountSummaryRows(
  tx: Tx,
  organizationId: string,
  period: { from: string; to: string; includeVoided?: boolean },
  locale: Locale,
): Promise<{ headers: string[]; rows: string[][] }> {
  const [org] = await tx`select base_currency from organizations where id = ${organizationId}`;
  const baseExponent = currencyExponent(org.base_currency as string);
  const includeVoided = period.includeVoided ?? false;

  const rows = await tx`
    select
      a.code,
      a.name_en,
      a.name_zh,
      a.type,
      coalesce(sum(l.base_amount_minor) filter (where l.direction = 'debit'), 0) as debit_total,
      coalesce(sum(l.base_amount_minor) filter (where l.direction = 'credit'), 0) as credit_total
    from accounts a
    join journal_lines l on l.account_id = a.id
    join transactions t on t.id = l.transaction_id
    where a.organization_id = ${organizationId}
      and t.organization_id = ${organizationId}
      and t.occurred_on >= ${period.from}::date
      and t.occurred_on <= ${period.to}::date
      and (${includeVoided} or t.voided_at is null)
    group by a.id, a.code, a.name_en, a.name_zh, a.type, a.sort_order
    order by a.type, a.sort_order, a.code
  `;

  return {
    headers: SUMMARY_HEADERS[locale],
    rows: rows.map((row) => {
      const debit = BigInt(row.debit_total);
      const credit = BigInt(row.credit_total);
      // 净额按科目性质取方向，让每个科目在其自然方向上为正数。
      // 保留符号：负数说明该科目当期落在自然方向的反面，是会计要看的异常信号。
      const net = DEBIT_NATURED.has(row.type as string) ? debit - credit : credit - debit;

      return [
        row.code as string,
        localizedName({ name_en: row.name_en, name_zh: row.name_zh }, locale),
        TYPE_LABELS[locale][row.type as string],
        formatMinorToDecimal(debit, baseExponent),
        formatMinorToDecimal(credit, baseExponent),
        formatMinorToDecimal(net, baseExponent),
      ];
    }),
  };
}
