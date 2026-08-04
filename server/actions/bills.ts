'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction } from '@/server/db/transaction';
import { requirePermission, AuthError } from '@/server/auth/guard';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import {
  getNextBillNumber,
  insertBill,
  insertBillItems,
  setBillStatus,
  type NewBillItemRow,
} from '@/server/repositories/bills';

type BillItemInput = {
  description: string;
  amount: string;
};

export type CreateBillInput = {
  contactId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  notes?: string;
  items: BillItemInput[];
};

export async function createBill(
  orgSlug: string,
  input: CreateBillInput,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  if (!input.items || input.items.length === 0) {
    throw new AuthError('forbidden', 'A bill needs at least one item.');
  }

  const result = await withTransaction(context.userId, async (tx) => {
    const billNumber = await getNextBillNumber(tx, context.organizationId);
    const exponent = currencyExponent(input.currency);

    const itemRows: { minor: bigint; row: Omit<NewBillItemRow, 'billId'> }[] =
      input.items.map((item) => {
        const amountMinor = parseDecimalToMinor(item.amount || '0', exponent);
        return {
          minor: amountMinor,
          row: {
            description: item.description,
            amountMinor,
          },
        };
      });

    const totalMinor = itemRows.reduce((sum, item) => sum + item.minor, 0n);

    const { id } = await insertBill(tx, {
      organizationId: context.organizationId,
      contactId: input.contactId,
      billNumber,
      status: 'received',
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currency: input.currency,
      totalMinor,
      notes: input.notes?.trim() || null,
    });

    await insertBillItems(
      tx,
      itemRows.map((item) => ({ ...item.row, billId: id })),
    );

    return { id };
  });

  revalidatePath(`/${orgSlug}/bills`);
  return result;
}

export async function voidBill(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  await withTransaction(context.userId, async (tx) => {
    await setBillStatus(tx, context.organizationId, id, 'voided');
  });

  revalidatePath(`/${orgSlug}/bills`);
}
