'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  insertFixedAsset,
  updateFixedAsset,
  disposeFixedAsset,
  generateDepreciationSchedule,
  getFixedAsset,
  postDepreciation,
  type DepreciationMethod,
} from '@/server/repositories/fixed_assets';
import {
  insertTransaction as insertTransactionRepo,
  insertJournalLines as insertJournalLinesRepo,
} from '@/server/repositories/transactions';
import { parseRateToScaled, convertToBaseMinor } from '@/server/domain/exchange-rate';

const createFixedAssetSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cost: z.string().min(1),
  salvageValue: z.string().default('0'),
  usefulLifeMonths: z.number().int().min(1),
  method: z.enum(['straight_line', 'declining_balance']).default('straight_line'),
  decliningRateBps: z.number().int().min(0).nullable().optional(),
  assetAccountId: z.string().uuid(),
  depnExpenseAccountId: z.string().uuid(),
  depnAccumAccountId: z.string().uuid(),
  originalCurrency: z.string().length(3).optional(),
  originalCostMinor: z.string().optional(),
  exchangeRate: z.string().regex(/^\d+(\.\d{1,8})?$/).optional(),
});

const updateFixedAssetSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cost: z.string().min(1).optional(),
  salvageValue: z.string().optional(),
  usefulLifeMonths: z.number().int().min(1).optional(),
  method: z.enum(['straight_line', 'declining_balance']).optional(),
  decliningRateBps: z.number().int().min(0).nullable().optional(),
  assetAccountId: z.string().uuid().optional(),
  depnExpenseAccountId: z.string().uuid().optional(),
  depnAccumAccountId: z.string().uuid().optional(),
});

function parseMinor(value: string): bigint {
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`Invalid amount: ${value}`);
  const [whole, fraction = ''] = cleaned.split('.');
  const padded = fraction.padEnd(2, '0').slice(0, 2);
  return BigInt(`${whole}${padded}`);
}

export async function createFixedAsset(
  orgSlug: string,
  input: z.infer<typeof createFixedAssetSchema>,
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = createFixedAssetSchema.parse(input);

  const result = await withTransaction(context.userId, async (tx) => {
    // 计算基准币种的 costMinor
    let costMinor: bigint;
    let originalCurrency: string | null = null;
    let originalCostMinor: bigint | null = null;
    let purchaseExchangeRate: bigint | null = null;

    if (parsed.originalCurrency && parsed.originalCurrency !== context.baseCurrency && parsed.exchangeRate) {
      // 有原币且不同于基准币种，需要换算
      originalCurrency = parsed.originalCurrency;
      originalCostMinor = parseMinor(parsed.originalCostMinor || parsed.cost);
      const scaledRate = parseRateToScaled(parsed.exchangeRate);
      purchaseExchangeRate = scaledRate;
      
      costMinor = convertToBaseMinor({
        amountMinor: originalCostMinor,
        currency: originalCurrency,
        baseCurrency: context.baseCurrency,
        scaledRate,
      });
    } else {
      // 无原币或原币等于基准币种，直接用 cost
      costMinor = parseMinor(parsed.cost);
    }

    const { id } = await insertFixedAsset(tx, {
      organizationId: context.organizationId,
      name: parsed.name,
      description: parsed.description ?? null,
      purchaseDate: parsed.purchaseDate,
      costMinor,
      salvageValueMinor: parseMinor(parsed.salvageValue),
      usefulLifeMonths: parsed.usefulLifeMonths,
      method: parsed.method as DepreciationMethod,
      decliningRateBps: parsed.decliningRateBps ?? null,
      assetAccountId: parsed.assetAccountId,
      depnExpenseAccountId: parsed.depnExpenseAccountId,
      depnAccumAccountId: parsed.depnAccumAccountId,
      originalCurrency,
      originalCostMinor,
      purchaseExchangeRate,
    });

    await generateDepreciationSchedule(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'fixed_asset.created',
      entityType: 'fixed_asset',
      entityId: id,
      after: { name: parsed.name, method: parsed.method },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/fixed-assets`);
  return result;
}

export async function updateFixedAssetAction(
  orgSlug: string,
  id: string,
  input: z.infer<typeof updateFixedAssetSchema>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = updateFixedAssetSchema.parse(input);

  await withTransaction(context.userId, async (tx) => {
    const updates: Parameters<typeof updateFixedAsset>[3] = {};
    if (parsed.name !== undefined) updates.name = parsed.name;
    if (parsed.description !== undefined) updates.description = parsed.description;
    if (parsed.purchaseDate !== undefined) updates.purchaseDate = parsed.purchaseDate;
    if (parsed.cost !== undefined) updates.costMinor = parseMinor(parsed.cost);
    if (parsed.salvageValue !== undefined) updates.salvageValueMinor = parseMinor(parsed.salvageValue);
    if (parsed.usefulLifeMonths !== undefined) updates.usefulLifeMonths = parsed.usefulLifeMonths;
    if (parsed.method !== undefined) updates.method = parsed.method as DepreciationMethod;
    if (parsed.decliningRateBps !== undefined) updates.decliningRateBps = parsed.decliningRateBps;
    if (parsed.assetAccountId !== undefined) updates.assetAccountId = parsed.assetAccountId;
    if (parsed.depnExpenseAccountId !== undefined) updates.depnExpenseAccountId = parsed.depnExpenseAccountId;
    if (parsed.depnAccumAccountId !== undefined) updates.depnAccumAccountId = parsed.depnAccumAccountId;

    await updateFixedAsset(tx, context.organizationId, id, updates);

    const needsRegen =
      parsed.cost !== undefined ||
      parsed.salvageValue !== undefined ||
      parsed.usefulLifeMonths !== undefined ||
      parsed.method !== undefined ||
      parsed.decliningRateBps !== undefined ||
      parsed.purchaseDate !== undefined;

    if (needsRegen) {
      await generateDepreciationSchedule(tx, context.organizationId, id);
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'fixed_asset.updated',
      entityType: 'fixed_asset',
      entityId: id,
      after: parsed,
    });
  });

  revalidatePath(`/${orgSlug}/fixed-assets`);
  revalidatePath(`/${orgSlug}/fixed-assets/${id}`);
}

export async function disposeFixedAssetAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const existing = await getFixedAsset(tx, context.organizationId, id);
    if (!existing) throw new Error('Fixed asset not found.');
    if (!existing.isActive) throw new Error('Asset is already disposed.');

    await disposeFixedAsset(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'fixed_asset.disposed',
      entityType: 'fixed_asset',
      entityId: id,
      before: { isActive: true },
      after: { isActive: false },
    });
  });

  revalidatePath(`/${orgSlug}/fixed-assets`);
  revalidatePath(`/${orgSlug}/fixed-assets/${id}`);
}

export async function postDepreciationAction(
  orgSlug: string,
  assetId: string,
  period: string,
): Promise<{ transactionId: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');

  const result = await withTransaction(context.userId, async (tx) => {
    return postDepreciation(tx, context.organizationId, assetId, period, {
      userId: context.userId,
      baseCurrency: context.baseCurrency,
      insertTransaction: insertTransactionRepo,
      insertJournalLines: insertJournalLinesRepo,
    });
  });

  revalidatePath(`/${orgSlug}/fixed-assets/${assetId}`);
  return result;
}
