'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { parseDecimalToMinor } from '@/server/domain/money';
import { insertTransaction, insertJournalLines } from '@/server/repositories/transactions';
import {
  getDueRecurring,
  insertRecurring,
  updateRecurring,
  setRecurringActive,
  computeNextDueDate,
} from '@/server/repositories/recurring';
import { recordAudit } from '@/server/repositories/audit-logs';
import type { TransactionKind } from '@/server/domain/ledger';
import type { RecurringTransactionRow } from '@/server/repositories/recurring';

export async function createRecurring(
  orgSlug: string,
  input: {
    kind: TransactionKind;
    description: string;
    amount: string;
    currency: string;
    debitAccountId: string;
    creditAccountId: string;
    categoryId: string;
    frequency: RecurringTransactionRow['frequency'];
    interval: number;
    startDate: string;
    endDate?: string;
  },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  // 验证 amount 是正的小数
  parseDecimalToMinor(input.amount, 2);

  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertRecurring(tx, {
      organizationId: context.organizationId,
      kind: input.kind,
      description: input.description?.trim() || null,
      amount: input.amount,
      currency: input.currency,
      debitAccountId: input.debitAccountId,
      creditAccountId: input.creditAccountId,
      categoryId: input.categoryId || null,
      frequency: input.frequency,
      interval: input.interval,
      startDate: input.startDate,
      endDate: input.endDate || null,
      nextDueDate: input.startDate,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'recurring.created',
      entityType: 'recurring_transaction',
      entityId: id,
      after: {
        kind: input.kind,
        description: input.description,
        amount: input.amount,
        frequency: input.frequency,
      },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/settings/recurring`);
  return result;
}

export async function editRecurring(
  orgSlug: string,
  id: string,
  fields: {
    description?: string;
    amount?: string;
    currency?: string;
    debitAccountId?: string;
    creditAccountId?: string;
    categoryId?: string;
    frequency?: RecurringTransactionRow['frequency'];
    interval?: number;
    startDate?: string;
    endDate?: string | null;
  },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  if (fields.amount) {
    parseDecimalToMinor(fields.amount, 2);
  }

  await withTransaction(context.userId, async (tx) => {
    await updateRecurring(tx, context.organizationId, id, {
      ...fields,
      description: fields.description?.trim() ?? undefined,
    });
  });

  revalidatePath(`/${orgSlug}/settings/recurring`);
}

export async function toggleRecurring(
  orgSlug: string,
  id: string,
  active: boolean,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  await withTransaction(context.userId, async (tx) => {
    await setRecurringActive(tx, context.organizationId, id, active);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: active ? 'recurring.activated' : 'recurring.deactivated',
      entityType: 'recurring_transaction',
      entityId: id,
      after: { isActive: active },
    });
  });

  revalidatePath(`/${orgSlug}/settings/recurring`);
}

export async function generateDueRecurring(
  orgSlug: string,
): Promise<{ generated: number }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const result = await withTransaction(context.userId, async (tx) => {
    const today = new Date().toISOString().slice(0, 10);
    const dueList = await getDueRecurring(tx, context.organizationId, today);

    let generated = 0;

    for (const entry of dueList) {
      const amountMinor = parseDecimalToMinor(entry.amount, 2);

      // Create the actual transaction
      const { id: txnId } = await insertTransaction(tx, {
        organizationId: context.organizationId,
        kind: entry.kind,
        occurredOn: today,
        description: entry.description ?? '',
        currency: entry.currency,
        amountMinor,
        baseAmountMinor: amountMinor,
        scaledRate: 100000000n,
        rateSource: 'manual',
        categoryId: entry.categoryId,
        createdBy: context.userId,
        clientUuid: crypto.randomUUID(),
      });

      await insertJournalLines(tx, context.organizationId, txnId, [
        {
          accountId: entry.debitAccountId,
          direction: 'debit',
          amountMinor,
          baseAmountMinor: amountMinor,
        },
        {
          accountId: entry.creditAccountId,
          direction: 'credit',
          amountMinor,
          baseAmountMinor: amountMinor,
        },
      ]);

      // Update next due date
      const nextDue = computeNextDueDate(
        entry.frequency,
        entry.interval,
        entry.nextDueDate,
      );

      await updateRecurring(tx, context.organizationId, entry.id, {
        nextDueDate: nextDue,
      });

      generated += 1;
    }

    return { generated };
  });

  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/settings/recurring`);
  return result;
}
