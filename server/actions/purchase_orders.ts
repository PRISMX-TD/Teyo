'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  getPurchaseOrder,
  insertPurchaseOrder,
  insertPoItems,
  updatePurchaseOrder,
  deletePoItems,
  setPoStatus,
  getNextPoNumber,
} from '@/server/repositories/purchase_orders';
import { RATE_SCALE } from '@/server/domain/exchange-rate';

export async function createPurchaseOrder(
  orgSlug: string,
  input: {
    contactId: string;
    issueDate: string;
    expectedDate?: string;
    currency?: string;
    exchangeRate?: string;
    notes?: string;
    items: {
      description: string;
      quantity: number;
      unitPriceMinor: string;
      amountMinor?: string;
      taxRateId?: string;
    }[];
  },
): Promise<{ id: string; poNumber: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');

  const result = await withTransaction(context.userId, async (tx) => {
    const poNumber = await getNextPoNumber(tx, context.organizationId);

    const exchangeRate = input.exchangeRate ? BigInt(input.exchangeRate) : RATE_SCALE;

    // 计算 baseTotalMinor = sum of item amountMinor
    const baseTotalMinor = input.items.reduce((sum, item) => {
      const amount = item.amountMinor ? BigInt(item.amountMinor) : 0n;
      return sum + amount;
    }, 0n);

    const { id } = await insertPurchaseOrder(tx, {
      organizationId: context.organizationId,
      contactId: input.contactId,
      poNumber,
      issueDate: input.issueDate,
      expectedDate: input.expectedDate,
      currency: input.currency ?? 'USD',
      exchangeRate,
      baseTotalMinor,
      notes: input.notes,
      createdBy: context.userId,
    });

    await insertPoItems(
      tx,
      input.items.map((item) => ({
        poId: id,
        description: item.description,
        quantity: item.quantity,
        unitPriceMinor: BigInt(item.unitPriceMinor),
        amountMinor: item.amountMinor ? BigInt(item.amountMinor) : BigInt(item.unitPriceMinor) * BigInt(Math.round(item.quantity)),
        taxRateId: item.taxRateId,
      })),
    );

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: id,
      after: { poNumber, contactId: input.contactId, itemCount: input.items.length },
    });

    return { id, poNumber };
  });

  revalidatePath(`/${orgSlug}/purchases`);
  return result;
}

export async function updatePurchaseOrderAction(
  orgSlug: string,
  id: string,
  input: {
    contactId?: string;
    issueDate?: string;
    expectedDate?: string;
    currency?: string;
    exchangeRate?: string;
    notes?: string;
    items?: {
      description: string;
      quantity: number;
      unitPriceMinor: string;
      amountMinor?: string;
      taxRateId?: string;
    }[];
  },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getPurchaseOrder(tx, context.organizationId, id);

    const fields: Record<string, unknown> = {};
    if (input.contactId !== undefined) fields.contactId = input.contactId;
    if (input.issueDate !== undefined) fields.issueDate = input.issueDate;
    if (input.expectedDate !== undefined) fields.expectedDate = input.expectedDate;
    if (input.currency !== undefined) fields.currency = input.currency;
    if (input.exchangeRate !== undefined) fields.exchangeRate = BigInt(input.exchangeRate);

    if (input.items) {
      const baseTotalMinor = input.items.reduce((sum, item) => {
        const amount = item.amountMinor ? BigInt(item.amountMinor) : 0n;
        return sum + amount;
      }, 0n);
      fields.baseTotalMinor = baseTotalMinor;
    }

    if (input.notes !== undefined) fields.notes = input.notes;

    if (Object.keys(fields).length > 0) {
      await updatePurchaseOrder(tx, context.organizationId, id, {
        contactId: fields.contactId as string | undefined,
        issueDate: fields.issueDate as string | undefined,
        expectedDate: fields.expectedDate as string | undefined,
        currency: fields.currency as string | undefined,
        exchangeRate: fields.exchangeRate as bigint | undefined,
        baseTotalMinor: fields.baseTotalMinor as bigint | undefined,
        notes: fields.notes as string | undefined,
      });
    }

    if (input.items) {
      await deletePoItems(tx, id);
      await insertPoItems(
        tx,
        input.items.map((item) => ({
          poId: id,
          description: item.description,
          quantity: item.quantity,
          unitPriceMinor: BigInt(item.unitPriceMinor),
          amountMinor: item.amountMinor ? BigInt(item.amountMinor) : BigInt(item.unitPriceMinor) * BigInt(Math.round(item.quantity)),
          taxRateId: item.taxRateId,
        })),
      );
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'purchase_order.updated',
      entityType: 'purchase_order',
      entityId: id,
      before: { poNumber: before?.poNumber },
      after: input,
    });
  });

  revalidatePath(`/${orgSlug}/purchases`);
  revalidatePath(`/${orgSlug}/purchases/${id}`);
}

export async function setPoStatusAction(
  orgSlug: string,
  id: string,
  status: 'draft' | 'sent' | 'received' | 'billed' | 'closed' | 'voided',
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getPurchaseOrder(tx, context.organizationId, id);

    await setPoStatus(tx, context.organizationId, id, status);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'purchase_order.status_changed',
      entityType: 'purchase_order',
      entityId: id,
      before: { status: before?.status },
      after: { status },
    });
  });

  revalidatePath(`/${orgSlug}/purchases`);
  revalidatePath(`/${orgSlug}/purchases/${id}`);
}
