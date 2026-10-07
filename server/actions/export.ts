'use server';

import { exportSchema, parseOrThrow } from '@/lib/schemas';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  buildAccountSummaryRows,
  buildCsv,
  buildTransactionDetailRows,
  buildXlsx,
  ExportError,
  type ExportFormat,
  type ExportKind,
} from '@/server/services/export-builder';

export type ExportInput = {
  kind: ExportKind;
  format: ExportFormat;
  from: string;
  to: string;
  locale: 'en' | 'zh';
  includeVoided?: boolean;
  categoryId?: string;
  moneyAccountId?: string;
  createdBy?: string;
  keyword?: string;
};

export type ExportResult = {
  fileName: string;
  contentType: string;
  /** base64，前端解码后触发下载。Server Action 不能直接回传流。 */
  body: string;
};

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const SHEET_NAMES: Record<ExportKind, string> = {
  'transaction-detail': 'Transactions',
  'account-summary': 'Summary',
};

export async function exportReport(orgSlug: string, input: ExportInput): Promise<ExportResult> {
  const context = await requirePermission(orgSlug, 'report:export');
  // 裸 .parse() 的 ZodError message 是一坨 JSON（起止日期填反时最常见），
  // 导出表单会把它原样贴出来。
  const parsed = parseOrThrow(exportSchema, input, (m) => new Error(m));

  // 取数与审计放在同一个事务里：审计写失败时不能把文件发出去，
  // 否则会出现导出了却查不到留痕的记录。
  // ExportError 只带消息键（见 export-builder.ts），原来没有任何地方调
  // localize()，用户看到的是「exportTooManyRows {"count":…}」。
  const { headers, rows } = await withTransaction(context.userId, async (tx) => {
    const built =
      parsed.kind === 'transaction-detail'
        ? await buildTransactionDetailRows(
            tx,
            context.organizationId,
            {
              from: parsed.from,
              to: parsed.to,
              includeVoided: parsed.includeVoided,
              categoryId: parsed.categoryId,
              moneyAccountId: parsed.moneyAccountId,
              createdBy: parsed.createdBy,
              keyword: parsed.keyword,
            },
            parsed.locale,
          )
        : await buildAccountSummaryRows(
            tx,
            context.organizationId,
            { from: parsed.from, to: parsed.to, includeVoided: parsed.includeVoided },
            parsed.locale,
          );

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'report.exported',
      entityType: 'report',
      entityId: null,
      after: {
        kind: parsed.kind,
        format: parsed.format,
        from: parsed.from,
        to: parsed.to,
        includeVoided: parsed.includeVoided,
        rowCount: built.rows.length,
      },
    });

    return built;
  }).catch((error: unknown) => {
    if (error instanceof ExportError) throw new Error(error.localize(parsed.locale));
    throw error;
  });

  const buffer =
    parsed.format === 'csv'
      ? buildCsv(headers, rows)
      : await buildXlsx(SHEET_NAMES[parsed.kind], headers, rows);

  return {
    fileName: `teyo-${parsed.kind}-${parsed.from}-to-${parsed.to}.${parsed.format}`,
    contentType: CONTENT_TYPES[parsed.format],
    body: buffer.toString('base64'),
  };
}
