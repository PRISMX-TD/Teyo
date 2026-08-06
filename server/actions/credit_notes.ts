'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTransaction } from '@/server/db/transaction';
import { requirePermission, AuthError } from '@/server/auth/guard';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import { parseRateToScaled, RATE_SCALE } from '@/server/domain/exchange-rate';
import {
  getNextCnNumber,
  insertCreditNote,
  insertCreditNoteItems,
  deleteCreditNoteItems,
  updateCreditNote,
  setCreditNoteStatus,
  type NewCreditNoteRow,
  type NewCreditNoteItemRow,
} from '@/server/repositories/credit_notes';

const creditNoteItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.string().optional().default('1'),
  unitPrice: z.string().optional().default('0'),
  taxRateId: z.string().uuid().nullable().optional(),
});

export type CreateCreditNoteInput = {
  invoiceId?: string | null;
  contactId: string;
  contactName?: string | null;
  issueDate: string;
  currency?: string;
  exchangeRate?: string;
  reason?: string | null;
  notes?: string | null;
  items: z.infer<typeof creditNoteItemSchema>[];
};

export type UpdateCreditNoteInput = {
  invoiceId?: string | null;
  contactId?: string;
  contactName?: string | null;
  issueDate?: string;
  currency?: string;
  exchangeRate?: string;
  reason?: string | null;
  notes?: string | null;
  items?: z.infer<typeof creditNoteItemSchema>[];
};

export async function createCreditNote(
  orgSlug: string,
  input: CreateCreditNoteInput,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  if (!input.items || input.items.length === 0) {
    throw new AuthError('forbidden', 'A credit note needs at least one item.');
  }

  const result = await withTransaction(context.userId, async (tx) => {
    const cnNumber = await getNextCnNumber(tx, context.organizationId);
    const currency = input.currency || context.baseCurrency;
    const exponent = currencyExponent(currency);

    const itemRows: {
      minor: bigint;
      row: Omit<NewCreditNoteItemRow, 'creditNoteId'>;
    }[] = input.items.map((item) => {
      const qty = item.quantity || '1';
      const unitPriceMinor = parseDecimalToMinor(item.unitPrice || '0', exponent);

      const qtyParts = qty.split('.');
      const qtyWhole = qtyParts[0];
      const qtyFrac = (qtyParts[1] ?? '').padEnd(4, '0').slice(0, 4);
      const unitBig = BigInt(unitPriceMinor.toString());
      const qtyBig = BigInt(qtyWhole) * 10000n + BigInt(qtyFrac);
      const amountMinor = (unitBig * qtyBig) / 10000n;

      return {
        minor: amountMinor,
        row: {
          description: item.description,
          quantity: qty,
          unitPriceMinor,
          amountMinor,
          taxRateId: item.taxRateId ?? null,
        },
      };
    });

    const baseAmountMinor = itemRows.reduce((sum, item) => sum + item.minor, 0n);

    const scaledRate = currency !== context.baseCurrency && input.exchangeRate
      ? parseRateToScaled(input.exchangeRate)
      : RATE_SCALE;

    const { id } = await insertCreditNote(tx, {
      organizationId: context.organizationId,
      invoiceId: input.invoiceId ?? null,
      contactId: input.contactId,
      contactName: input.contactName ?? null,
      cnNumber,
      status: 'draft',
      issueDate: input.issueDate,
      currency,
      exchangeRate: scaledRate,
      baseAmountMinor,
      reason: input.reason?.trim() || null,
      notes: input.notes?.trim() || null,
      createdBy: context.userId,
    });

    await insertCreditNoteItems(
      tx,
      itemRows.map((item) => ({ ...item.row, creditNoteId: id })),
    );

    return { id };
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
  return result;
}

export async function updateCreditNoteAction(
  orgSlug: string,
  id: string,
  input: UpdateCreditNoteInput,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    const fields: Parameters<typeof updateCreditNote>[3] = {};

    if (input.invoiceId !== undefined) fields.invoiceId = input.invoiceId;
    if (input.contactId !== undefined) fields.contactId = input.contactId;
    if (input.contactName !== undefined) fields.contactName = input.contactName;
    if (input.issueDate !== undefined) fields.issueDate = input.issueDate;
    if (input.currency !== undefined) fields.currency = input.currency;
    if (input.reason !== undefined) fields.reason = input.reason?.trim() || null;
    if (input.notes !== undefined) fields.notes = input.notes?.trim() || null;

    if (input.exchangeRate !== undefined) {
      fields.exchangeRate = parseRateToScaled(input.exchangeRate);
    }

    if (input.items !== undefined) {
      const currency = input.currency ?? context.baseCurrency;
      const exponent = currencyExponent(currency);

      const baseAmountMinor = input.items.reduce((sum, item) => {
        const qty = item.quantity || '1';
        const unitPriceMinor = parseDecimalToMinor(item.unitPrice || '0', exponent);

        const qtyParts = qty.split('.');
        const qtyWhole = qtyParts[0];
        const qtyFrac = (qtyParts[1] ?? '').padEnd(4, '0').slice(0, 4);
        const unitBig = BigInt(unitPriceMinor.toString());
        const qtyBig = BigInt(qtyWhole) * 10000n + BigInt(qtyFrac);
        return sum + (unitBig * qtyBig) / 10000n;
      }, 0n);

      fields.baseAmountMinor = baseAmountMinor;

      await deleteCreditNoteItems(tx, id);
      await insertCreditNoteItems(
        tx,
        input.items.map((item) => {
          const qty = item.quantity || '1';
          const unitPriceMinor = parseDecimalToMinor(item.unitPrice || '0', exponent);

          const qtyParts = qty.split('.');
          const qtyWhole = qtyParts[0];
          const qtyFrac = (qtyParts[1] ?? '').padEnd(4, '0').slice(0, 4);
          const unitBig = BigInt(unitPriceMinor.toString());
          const qtyBig = BigInt(qtyWhole) * 10000n + BigInt(qtyFrac);
          const amountMinor = (unitBig * qtyBig) / 10000n;

          return {
            creditNoteId: id,
            description: item.description,
            quantity: qty,
            unitPriceMinor,
            amountMinor,
            taxRateId: item.taxRateId ?? null,
          };
        }),
      );
    }

    await updateCreditNote(tx, context.organizationId, id, fields);
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
  revalidatePath(`/${orgSlug}/credit-notes/${id}`);
}

export async function issueCreditNote(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    await setCreditNoteStatus(tx, context.organizationId, id, 'issued');
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
}

export async function applyCreditNote(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    await setCreditNoteStatus(tx, context.organizationId, id, 'applied');
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
}

export async function voidCreditNote(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    await setCreditNoteStatus(tx, context.organizationId, id, 'voided');
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
}
