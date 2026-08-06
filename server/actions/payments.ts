'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTransaction } from '@/server/db/transaction';
import { requirePermission, AuthError } from '@/server/auth/guard';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import {
  parseRateToScaled,
  RATE_SCALE,
} from '@/server/domain/exchange-rate';
import { findRate } from '@/server/repositories/exchange-rates';
import {
  insertPayment,
  insertPaymentItems,
  voidPayment,
  type NewPaymentRow,
  type NewPaymentItem,
} from '@/server/repositories/payments';

const paymentItemSchema = z.object({
  invoiceId: z.string().uuid().nullable().optional(),
  billId: z.string().uuid().nullable().optional(),
  amount: z.string().min(1),
});

const createPaymentSchema = z.object({
  contactId: z.string().uuid(),
  type: z.enum(['received', 'made']),
  amount: z.string().min(1),
  currency: z.string().length(3).default('USD'),
  exchangeRate: z.string().optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(['cash', 'bank_transfer', 'cheque', 'online', 'other']).default('bank_transfer'),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  transactionId: z.string().uuid().nullable().optional(),
  items: z.array(paymentItemSchema).min(1),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export async function createPayment(
  orgSlug: string,
  input: CreatePaymentInput,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');
  const parsed = createPaymentSchema.parse(input);

  const result = await withTransaction(context.userId, async (tx) => {
    let scaledRate: bigint;
    if (parsed.exchangeRate !== undefined && parsed.exchangeRate !== '') {
      scaledRate = parseRateToScaled(parsed.exchangeRate);
    } else if (parsed.currency === context.baseCurrency) {
      scaledRate = RATE_SCALE;
    } else {
      const cached = await findRate(tx, parsed.currency, context.baseCurrency, parsed.paymentDate);
      if (!cached) {
        throw new AuthError(
          'forbidden',
          `No exchange rate available for ${parsed.currency} to ${context.baseCurrency} on ${parsed.paymentDate}.`,
        );
      }
      scaledRate = cached.scaledRate;
    }

    const amountMinor = parseDecimalToMinor(parsed.amount, currencyExponent(parsed.currency));

    const baseAmountMinor =
      parsed.currency === context.baseCurrency
        ? amountMinor
        : (amountMinor * scaledRate) / RATE_SCALE;

    const row: NewPaymentRow = {
      organizationId: context.organizationId,
      contactId: parsed.contactId,
      type: parsed.type,
      amountMinor,
      currency: parsed.currency,
      exchangeRate: scaledRate,
      baseAmountMinor,
      paymentDate: parsed.paymentDate,
      method: parsed.method,
      reference: parsed.reference ?? null,
      notes: parsed.notes ?? null,
      transactionId: parsed.transactionId ?? null,
      createdBy: context.userId,
    };

    const { id } = await insertPayment(tx, row);

    const items: NewPaymentItem[] = parsed.items.map((item) => ({
      paymentId: id,
      invoiceId: item.invoiceId ?? null,
      billId: item.billId ?? null,
      amountMinor: parseDecimalToMinor(item.amount, currencyExponent(parsed.currency)),
    }));

    await insertPaymentItems(tx, items);

    return { id };
  });

  revalidatePath(`/${orgSlug}/payments`);
  return result;
}

export async function voidPaymentAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    await voidPayment(tx, context.organizationId, id);
  });

  revalidatePath(`/${orgSlug}/payments`);
}