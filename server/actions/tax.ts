'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  insertTaxRate,
  updateTaxRate,
  setDefaultTaxRate,
  deleteTaxRate,
  getTaxReport,
} from '@/server/repositories/tax';

const createTaxRateSchema = z.object({
  nameEn: z.string().min(1).max(100),
  nameZh: z.string().min(1).max(100),
  rateBps: z.number().int().min(0),
  isDefault: z.boolean().default(false),
});

const updateTaxRateSchema = z.object({
  nameEn: z.string().min(1).max(100).optional(),
  nameZh: z.string().min(1).max(100).optional(),
  rateBps: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
});

export async function createTaxRate(
  orgSlug: string,
  input: z.infer<typeof createTaxRateSchema>,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = createTaxRateSchema.parse(input);

  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertTaxRate(tx, {
      organizationId: context.organizationId,
      nameEn: parsed.nameEn,
      nameZh: parsed.nameZh,
      rateBps: parsed.rateBps,
      isDefault: parsed.isDefault,
    });

    if (parsed.isDefault) {
      await setDefaultTaxRate(tx, context.organizationId, id);
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'tax_rate.created',
      entityType: 'tax_rate',
      entityId: id,
      after: parsed,
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/settings/tax`);
  return result;
}

export async function updateTaxRateAction(
  orgSlug: string,
  id: string,
  input: z.infer<typeof updateTaxRateSchema>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = updateTaxRateSchema.parse(input);

  await withTransaction(context.userId, async (tx) => {
    await updateTaxRate(tx, context.organizationId, id, parsed);

    if (parsed.isDefault) {
      await setDefaultTaxRate(tx, context.organizationId, id);
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'tax_rate.updated',
      entityType: 'tax_rate',
      entityId: id,
      after: parsed,
    });
  });

  revalidatePath(`/${orgSlug}/settings/tax`);
}

export async function setDefaultTaxRateAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    await setDefaultTaxRate(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'tax_rate.default_changed',
      entityType: 'tax_rate',
      entityId: id,
      after: { isDefault: true },
    });
  });

  revalidatePath(`/${orgSlug}/settings/tax`);
}

export async function deleteTaxRateAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    await deleteTaxRate(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'tax_rate.deleted',
      entityType: 'tax_rate',
      entityId: id,
      after: { isActive: false },
    });
  });

  revalidatePath(`/${orgSlug}/settings/tax`);
}

export async function getTaxReportAction(
  orgSlug: string,
  from: string,
  to: string,
): Promise<{
  outputTax: { taxRateName: string | null; taxRate: number; netAmount: bigint; taxAmount: bigint }[];
  inputTax: { taxRateName: string | null; taxRate: number; netAmount: bigint; taxAmount: bigint }[];
}> {
  const context = await requirePermission(orgSlug, 'report:export');

  return withTransaction(context.userId, (tx) =>
    getTaxReport(tx, context.organizationId, from, to),
  );
}
