'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  getInventoryItem,
  insertInventoryItem,
  updateInventoryItem,
  setItemActive,
  recordInventoryTransaction,
} from '@/server/repositories/inventory';

export async function createInventoryItem(
  orgSlug: string,
  input: {
    sku: string;
    nameEn: string;
    nameZh: string;
    unit: string;
    costMethod: 'fifo' | 'average';
    reorderLevel?: number;
    cogsAccountId?: string;
    inventoryAccountId?: string;
  },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');

  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertInventoryItem(tx, {
      organizationId: context.organizationId,
      sku: input.sku,
      nameEn: input.nameEn,
      nameZh: input.nameZh,
      unit: input.unit,
      costMethod: input.costMethod,
      reorderLevel: input.reorderLevel ?? 0,
      cogsAccountId: input.cogsAccountId,
      inventoryAccountId: input.inventoryAccountId,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'inventory_item.created',
      entityType: 'inventory_item',
      entityId: id,
      after: input,
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/inventory`);
  return result;
}

export async function updateInventoryItemAction(
  orgSlug: string,
  id: string,
  input: Partial<{
    sku: string;
    nameEn: string;
    nameZh: string;
    unit: string;
    costMethod: 'fifo' | 'average';
    reorderLevel: number;
    cogsAccountId: string;
    inventoryAccountId: string;
  }>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getInventoryItem(tx, context.organizationId, id);

    await updateInventoryItem(tx, context.organizationId, id, input);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'inventory_item.updated',
      entityType: 'inventory_item',
      entityId: id,
      before: { sku: before?.sku, nameEn: before?.nameEn },
      after: input,
    });
  });

  revalidatePath(`/${orgSlug}/inventory`);
  revalidatePath(`/${orgSlug}/inventory/${id}`);
}

export async function toggleInventoryItemActive(
  orgSlug: string,
  id: string,
  active: boolean,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getInventoryItem(tx, context.organizationId, id);

    await setItemActive(tx, context.organizationId, id, active);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: active ? 'inventory_item.activated' : 'inventory_item.deactivated',
      entityType: 'inventory_item',
      entityId: id,
      before: { isActive: before?.isActive },
      after: { isActive: active },
    });
  });

  revalidatePath(`/${orgSlug}/inventory`);
}

export async function recordInventoryTxnAction(
  orgSlug: string,
  input: {
    inventoryItemId: string;
    type: 'purchase' | 'sale' | 'adjustment' | 'return';
    quantity: number;
    unitCostMinor: string;
    referenceType?: string;
    referenceId?: string;
    notes?: string;
  },
): Promise<{ id: string; newQuantity: number; newAvgCostMinor: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');

  const result = await withTransaction(context.userId, async (tx) => {
    const { id, newQuantity, newAvgCostMinor } = await recordInventoryTransaction(
      tx,
      context.organizationId,
      {
        inventoryItemId: input.inventoryItemId,
        type: input.type,
        quantity: input.quantity,
        unitCostMinor: BigInt(input.unitCostMinor),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        notes: input.notes,
        createdBy: context.userId,
      },
    );

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'inventory_transaction.recorded',
      entityType: 'inventory_transaction',
      entityId: id,
      after: {
        inventoryItemId: input.inventoryItemId,
        type: input.type,
        quantity: input.quantity,
        unitCostMinor: input.unitCostMinor,
      },
    });

    return {
      id,
      newQuantity,
      newAvgCostMinor: newAvgCostMinor.toString(),
    };
  });

  revalidatePath(`/${orgSlug}/inventory`);
  revalidatePath(`/${orgSlug}/inventory/${input.inventoryItemId}`);
  return result;
}
