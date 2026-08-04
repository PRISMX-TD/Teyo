'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  setBudget,
} from '@/server/repositories/budgets';
import { parseDecimalToMinor } from '@/server/domain/money';

export async function updateBudget(
  orgSlug: string,
  input: {
    accountId: string;
    year: number;
    month: number;
    amount: string;
  },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  const budgetMinor = parseDecimalToMinor(input.amount, 2);

  await withTransaction(context.userId, async (tx) => {
    await setBudget(
      tx,
      context.organizationId,
      input.accountId,
      input.year,
      input.month,
      budgetMinor,
    );

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'budget.updated',
      entityType: 'budget',
      entityId: `${input.accountId}/${input.year}/${input.month}`,
      after: {
        accountId: input.accountId,
        year: input.year,
        month: input.month,
        amount: input.amount,
      },
    });
  });

  revalidatePath(`/${orgSlug}/budgets`);
}
