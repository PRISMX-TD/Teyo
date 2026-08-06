'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction } from '@/server/db/transaction';
import { requirePermission, AuthError } from '@/server/auth/guard';
import { parseDecimalToMinor, currencyExponent } from '@/server/domain/money';
import { parseCsvBuffer, parseOfxBuffer, parseQifBuffer } from '@/server/services/bank_import_parser';
import {
  insertImportedTransactions,
  matchImportedTransaction,
  ignoreImportedTransaction,
  resetImportedTransaction,
} from '@/server/repositories/bank_import';

function detectFormat(fileName: string): 'csv' | 'ofx' | 'qif' {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'csv') return 'csv';
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';
  if (ext === 'qif') return 'qif';
  throw new AuthError(
    'forbidden',
    `Unsupported file format: ${ext}. Only .csv, .ofx, .qfx, and .qif files are accepted.`,
  );
}

export async function uploadBankStatement(
  orgSlug: string,
  formData: FormData,
): Promise<{ count: number }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    throw new AuthError('forbidden', 'No file provided.');
  }

  const moneyAccountId = formData.get('moneyAccountId');
  if (!moneyAccountId || typeof moneyAccountId !== 'string') {
    throw new AuthError('forbidden', 'No money account specified.');
  }

  const format = detectFormat(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());

  let parsed: {
    date: string;
    description: string;
    amount: string;
    rawRow: Record<string, string>;
  }[];

  if (format === 'csv') {
    parsed = parseCsvBuffer(buffer);
  } else if (format === 'ofx') {
    parsed = parseOfxBuffer(buffer);
  } else {
    parsed = parseQifBuffer(buffer);
  }

  if (parsed.length === 0) {
    throw new AuthError('forbidden', 'No transactions found in the uploaded file.');
  }

  // Figure out the currency exponent from the org's base currency
  const exponent = currencyExponent(context.baseCurrency);

  await withTransaction(context.userId, async (tx) => {
    await insertImportedTransactions(
      tx,
      parsed.map((p) => {
        // Amount from bank can be negative (withdrawal) or positive (deposit).
        // parseDecimalToMinor requires non-negative, so handle sign manually.
        const rawAmount = p.amount || '0';
        const isNegative = rawAmount.startsWith('-');
        const unsigned = isNegative ? rawAmount.slice(1) : rawAmount;
        let minor: bigint;
        try {
          minor = parseDecimalToMinor(unsigned, exponent);
          if (isNegative) minor = -minor;
        } catch {
          minor = 0n;
        }

        return {
          organizationId: context.organizationId,
          moneyAccountId,
          source: format,
          rawData: p.rawRow as Record<string, unknown>,
          transactionDate: p.date,
          description: p.description || null,
          amountMinor: minor,
          createdBy: context.userId,
        };
      }),
    );
  });

  revalidatePath(`/${orgSlug}/bank-import`);
  return { count: parsed.length };
}

export async function matchTransaction(
  orgSlug: string,
  id: string,
  matchedTransactionId: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    await matchImportedTransaction(tx, context.organizationId, id, matchedTransactionId);
  });

  revalidatePath(`/${orgSlug}/bank-import`);
}

export async function ignoreImportedAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    await ignoreImportedTransaction(tx, context.organizationId, id);
  });

  revalidatePath(`/${orgSlug}/bank-import`);
}

export async function resetImportedAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    await resetImportedTransaction(tx, context.organizationId, id);
  });

  revalidatePath(`/${orgSlug}/bank-import`);
}
