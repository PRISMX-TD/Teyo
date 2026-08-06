'use server';

import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import {
  getInvoicePdfData,
  type InvoicePdfData,
} from '@/server/repositories/invoice_pdf';

export type { InvoicePdfData } from '@/server/repositories/invoice_pdf';

/**
 * 获取发票 PDF 所需的数据。PDF 的实际渲染由客户端或后续服务端 PDF 库完成。
 */
export async function generateInvoicePdf(
  orgSlug: string,
  invoiceId: string,
): Promise<InvoicePdfData | null> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  return withTransaction(context.userId, (tx) =>
    getInvoicePdfData(tx, context.organizationId, invoiceId),
  );
}
