'use server';

import { exportSchema } from '@/lib/schemas';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  buildAccountSummaryRows,
  buildCsv,
  buildTransactionDetailRows,
  buildXlsx,
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
  const parsed = exportSchema.parse(input);

  // 取数与审计放在同一个事务里：审计写失败时不能把文件发出去，
  // 否则会出现导出了却查不到留痕的记录。
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
