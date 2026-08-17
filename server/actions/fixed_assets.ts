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
  loadDepreciationPosting,
  markDepreciationPosted,
  type DepreciationMethod,
} from '@/server/repositories/fixed_assets';
import { postJournal } from '@/server/posting/post-journal';
import { parseRateToScaled, convertToBaseMinor } from '@/server/domain/exchange-rate';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';

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

/**
 * 表单送来的十进制金额 -> 最小货币单位，小数位由币种决定。
 *
 * 这里原来有一个自己写的 parseMinor，无论币种一律 `padEnd(2,'0').slice(0,2)`。
 * 两处都会出错：
 *
 * 1. 零小数币种被放大一百倍。JPY 没有分币（见 money.ts 的 ZERO_DECIMAL_CURRENCIES），
 *    JPY 150000 应当就是 150000 minor；按两位解析成 15000000 minor 之后，
 *    convertToBaseMinor 又按 fromExponent = 0 再乘一次 10^2 折算到 MYR——
 *    0.031 的汇率下账面原值成了 MYR 465,000 而不是 MYR 4,650，并且这条资产
 *    往后每一期折旧都照着这个数摊。购入币种下拉框列的就是 SUPPORTED_CURRENCIES，
 *    JPY 与 VND 都在里面，从界面上点得到。
 * 2. 多余的小数被静默截断。`.slice(0,2)` 把 100.999 变成 100.99，用户看到的
 *    是保存成功，账上是另一个数——与本阶段要防的失败模式完全一致。
 *    parseDecimalToMinor 遇到这种输入抛错，表单会把错误显示出来。
 *
 * 之所以要传币种：原币成本按原币的小数位解析，账面原值与残值按本位币的。
 */
function parseAmountMinor(value: string, currency: string): bigint {
  return parseDecimalToMinor(value, currencyExponent(currency));
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

    if (parsed.originalCurrency && parsed.originalCurrency !== context.baseCurrency) {
      // 有原币且不同于基准币种，需要换算。
      //
      // 汇率缺失时不能落回 else 那一支：那一支把 cost 当作本位币直接入账，
      // 一笔 JPY 的成本会被原样记成 MYR。与 resolveRate 拒绝回退 1:1 同理，
      // 宁可当场报错，也不写一个事后看不出来的数。
      if (!parsed.exchangeRate) {
        throw new Error(
          `Enter the ${parsed.originalCurrency} to ${context.baseCurrency} rate on the purchase date.`,
        );
      }
      originalCurrency = parsed.originalCurrency;
      originalCostMinor = parseAmountMinor(
        parsed.originalCostMinor || parsed.cost,
        originalCurrency,
      );
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
      costMinor = parseAmountMinor(parsed.cost, context.baseCurrency);
    }

    const { id } = await insertFixedAsset(tx, {
      organizationId: context.organizationId,
      name: parsed.name,
      description: parsed.description ?? null,
      purchaseDate: parsed.purchaseDate,
      costMinor,
      // 残值与账面原值同为本位币：表单上这一栏的标签写的就是本位币
      // （见 components/fixed-assets/asset-form.tsx），排程表也按本位币摊。
      salvageValueMinor: parseAmountMinor(parsed.salvageValue, context.baseCurrency),
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
    // 编辑表单没有币种字段：cost 改的是 fixed_assets.cost_minor，那一列存的
    // 是本位币账面原值（原币三个字段只作购入留痕，见 0011 迁移）。
    if (parsed.cost !== undefined) {
      updates.costMinor = parseAmountMinor(parsed.cost, context.baseCurrency);
    }
    if (parsed.salvageValue !== undefined) {
      updates.salvageValueMinor = parseAmountMinor(parsed.salvageValue, context.baseCurrency);
    }
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

/**
 * 过一期折旧：读 -> 记账 -> 标记，三步都在同一个事务里。
 *
 * 记账那一步以前在仓储层，靠注入两个写入函数完成（见 fixed_assets 仓储里
 * loadDepreciationPosting 的注释）。改走 postJournal 之后这条路径顺带拿到
 * 两样它一直缺的东西：期间锁检查，以及一条带科目代码的审计快照——两样都
 * 不是这里写的代码，而是边界本身就会做的事。
 *
 * 折旧的方向：借折旧费用、贷累计折旧。累计折旧是资产的备抵科目，贷方增加，
 * 与资产科目本身的方向相反——写反不会有任何报错（一借一贷照样配平），只会
 * 让资产负债表两头同时错。
 *
 * 币种恒为本位币：排程表里的金额本来就是按 cost_minor 算的，而 cost_minor
 * 是本位币（原币三个字段只作购入留痕，见 0011 迁移）。所以 resolveRate 会
 * 走同币种那一支直接返回 RATE_SCALE，不查缓存，也就不需要在这里绕开它。
 */
export async function postDepreciationAction(
  orgSlug: string,
  assetId: string,
  period: string,
): Promise<{ transactionId: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');

  const result = await withTransaction(context.userId, async (tx) => {
    const pending = await loadDepreciationPosting(tx, context.organizationId, assetId, period);

    const { transactionId } = await postJournal(tx, context, {
      event: {
        type: 'journal',
        debitAccountId: pending.depnExpenseAccountId,
        creditAccountId: pending.depnAccumAccountId,
        amountMinor: pending.depreciationMinor,
      },
      occurredOn: period,
      description: `Depreciation: ${pending.assetName} (${period})`,
      currency: context.baseCurrency,
      // 折旧恒为本位币，resolveRate 走同币种那一支，够不到这句报错；
      // 即便够到，这个按钮旁边也没有任何填汇率的地方。
      manualRateEntry: 'unavailable',
      categoryId: null,
      // 每次点击都是一个新的 clientUuid，所以幂等靠的不是它，而是排程行上的
      // is_posted 加那把行锁（见 loadDepreciationPosting）。
      clientUuid: crypto.randomUUID(),
      sourceType: 'fixed_asset',
      sourceId: assetId,
    });

    await markDepreciationPosted(tx, context.organizationId, pending.scheduleId, transactionId);

    return { transactionId };
  });

  revalidatePath(`/${orgSlug}/fixed-assets/${assetId}`);
  return result;
}
