'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { parseDecimalToMinor } from '@/server/domain/money';
import {
  createReconciliation,
  addReconciliationItem,
  updateReconciliationItem,
  completeReconciliation,
} from '@/server/repositories/reconciliation';
import { recordAudit } from '@/server/repositories/audit-logs';

export async function reconcile(
  orgSlug: string,
  input: {
    moneyAccountId: string;
    statementDate: string;
    statementBalance: string;
    itemIds: string[];
    adjustments: Record<string, string>;
  },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  const statementBalanceMinor = parseDecimalToMinor(
    input.statementBalance,
    2,
  );

  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await createReconciliation(tx, {
      organizationId: context.organizationId,
      moneyAccountId: input.moneyAccountId,
      statementDate: input.statementDate,
      statementBalanceMinor,
      createdBy: context.userId,
    });

    for (const itemId of input.itemIds) {
      const adj = input.adjustments[itemId] ?? '0';
      const adjMinor = parseDecimalToMinor(adj, 2);
      await addReconciliationItem(tx, {
        reconciliationId: id,
        transactionId: itemId,
        isCleared: true,
        adjustmentMinor: adjMinor,
        note: null,
      });
    }

    await completeReconciliation(tx, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'reconciliation.completed',
      entityType: 'reconciliation',
      entityId: id,
      after: {
        moneyAccountId: input.moneyAccountId,
        statementDate: input.statementDate,
        items: input.itemIds.length,
      },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/reconciliation`);
  return result;
}

export async function updateItem(
  orgSlug: string,
  id: string,
  cleared: boolean,
  adjustment: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');
  const adjMinor = parseDecimalToMinor(adjustment, 2);

  await withTransaction(context.userId, async (tx) => {
    await updateReconciliationItem(tx, id, cleared, adjMinor);
  });

  revalidatePath(`/${orgSlug}/reconciliation`);
}

export async function complete(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  await withTransaction(context.userId, async (tx) => {
    await completeReconciliation(tx, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'reconciliation.completed',
      entityType: 'reconciliation',
      entityId: id,
      after: { completed: true },
    });
  });

  revalidatePath(`/${orgSlug}/reconciliation`);
}
