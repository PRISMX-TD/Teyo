'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission, AuthError } from '@/server/auth/guard';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import {
  getNextInvoiceNumber,
  insertInvoice,
  insertInvoiceItems,
  setInvoiceStatus,
  type NewInvoiceRow,
  type NewInvoiceItemRow,
} from '@/server/repositories/invoices';

type InvoiceItemInput = {
  description: string;
  quantity: string;
  unitPrice: string;
};

export type CreateInvoiceInput = {
  contactId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  taxRatePercent: string;
  notes?: string;
  items: InvoiceItemInput[];
};

/**
 * 创建发票：链接客户、存储明细。
 * 不自动创建交易——发票独立于收款，收款另记收入分录。
 */
export async function createInvoice(
  orgSlug: string,
  input: CreateInvoiceInput,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  if (!input.items || input.items.length === 0) {
    throw new AuthError('forbidden', 'An invoice needs at least one item.');
  }

  const result = await withTransaction(context.userId, async (tx) => {
    const invoiceNumber = await getNextInvoiceNumber(tx, context.organizationId);
    const exponent = currencyExponent(input.currency);
    const taxRatePercent = parseFloat(input.taxRatePercent) || 0;
    const taxRateBps = Math.round(taxRatePercent * 100);

    const itemRows: { minor: bigint; row: Omit<NewInvoiceItemRow, 'invoiceId'> }[] =
      input.items.map((item) => {
        const qty = item.quantity || '1';
        const unitPriceMinor = parseDecimalToMinor(item.unitPrice || '0', exponent);
        // quantity * unitPriceMinor，quantity 是 numeric(12,4)，用字符串构造大数乘法
        const unitStr = unitPriceMinor.toString();
        const qtyParts = qty.split('.');
        const qtyWhole = qtyParts[0];
        const qtyFrac = (qtyParts[1] ?? '').padEnd(4, '0').slice(0, 4);
        // amount = unitPriceMinor * quantity as string integer
        const unitBig = BigInt(unitStr);
        const qtyBig = BigInt(qtyWhole) * 10000n + BigInt(qtyFrac);
        const amountMinor = (unitBig * qtyBig) / 10000n;

        return {
          minor: amountMinor,
          row: {
            description: item.description,
            quantity: qty,
            unitPriceMinor,
            amountMinor,
          },
        };
      });

    const subTotalMinor = itemRows.reduce((sum, item) => sum + item.minor, 0n);
    const taxMinor = (subTotalMinor * BigInt(taxRateBps)) / 10000n;
    const totalMinor = subTotalMinor + taxMinor;

    const { id } = await insertInvoice(tx, {
      organizationId: context.organizationId,
      contactId: input.contactId,
      invoiceNumber,
      status: 'draft',
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currency: input.currency,
      subTotalMinor,
      taxRateBps,
      taxMinor,
      totalMinor,
      notes: input.notes?.trim() || null,
    });

    await insertInvoiceItems(
      tx,
      itemRows.map((item) => ({ ...item.row, invoiceId: id })),
    );

    return { id };
  });

  revalidatePath(`/${orgSlug}/invoices`);
  return result;
}

/**
 * 作废发票：仅标记，不删除。
 */
export async function voidInvoice(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  await withTransaction(context.userId, async (tx) => {
    await setInvoiceStatus(tx, context.organizationId, id, 'voided');
  });

  revalidatePath(`/${orgSlug}/invoices`);
}
