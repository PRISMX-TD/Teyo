'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isoDate } from '@/lib/schemas';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  insertFixedAsset,
  updateFixedAsset,
  generateDepreciationSchedule,
  getFixedAsset,
  loadDepreciationPosting,
  markDepreciationPosted,
  loadDisposalPosting,
  assertMoneyAccountInOrg,
  markAssetDisposed,
  reactivateDisposedAsset,
  type DepreciationMethod,
} from '@/server/repositories/fixed-assets';
import { findAccountByCode } from '@/server/repositories/accounts';
import { postJournal } from '@/server/posting/post-journal';
import { assetDisposalTotal } from '@/server/domain/posting-templates';
import { LedgerError } from '@/server/domain/ledger';
import { voidDocumentPosting } from '@/server/services/document-posting';
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

/**
 * 三个科目必须属于本公司。
 *
 * fixed_assets 上那三条外键只保证科目存在，不管它属于哪家公司，而 RLS 不对
 * 外键校验生效——与 server/posting/insert.ts 的 assertAccountsBelongToOrg
 * 是同一类洞。不在这里拦，别家公司的科目名会经详情页那三个 join 显示出来，
 * 而第一期折旧要到过账时才被拒。
 */
async function assertAssetAccountsBelongToOrg(
  tx: Tx,
  organizationId: string,
  accountIds: (string | undefined)[],
): Promise<void> {
  const ids = [...new Set(accountIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  const rows = await tx`
    select id from accounts
    where organization_id = ${organizationId} and id = any(${ids}::uuid[])
  `;
  if (rows.length !== ids.length) {
    throw new Error('One of the selected accounts was not found in this company.');
  }
}

/** 残值超过原值，排程里每一期都是 0——保存成功，却永远折不出一分钱。 */
function assertSalvageWithinCost(costMinor: bigint, salvageValueMinor: bigint): void {
  if (salvageValueMinor > costMinor) {
    throw new Error('The salvage value cannot be more than the cost.');
  }
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

    const salvageValueMinor = parseAmountMinor(parsed.salvageValue, context.baseCurrency);
    assertSalvageWithinCost(costMinor, salvageValueMinor);
    await assertAssetAccountsBelongToOrg(tx, context.organizationId, [
      parsed.assetAccountId,
      parsed.depnExpenseAccountId,
      parsed.depnAccumAccountId,
    ]);

    const { id } = await insertFixedAsset(tx, {
      organizationId: context.organizationId,
      name: parsed.name,
      description: parsed.description ?? null,
      purchaseDate: parsed.purchaseDate,
      costMinor,
      // 残值与账面原值同为本位币：表单上这一栏的标签写的就是本位币
      // （见 components/fixed-assets/asset-form.tsx），排程表也按本位币摊。
      salvageValueMinor,
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

/**
 * 改一条资产的属性；关键参数变了就重算排程。
 *
 * 返回值不是 void 而是被冻结的那些期间：generateDepreciationSchedule 现在
 * 拒绝改写任何已过账的期间（原因见那个函数的注释——改写它们会让同一期折旧
 * 记第二笔，而四道校验一道都看不出来），于是「我把年限从 4 个月改成 6 个月，
 * 为什么前两期的金额没跟着变」必须有个地方能答得上来。把期间列表交回给调用方，
 * 界面就能说清楚「前 N 期已入账，本次改动只影响之后的期间」——option (a) 的
 * 那句提示不是额外的 UI 工作，是这个返回值。
 *
 * 加返回值不会打断既有调用方：TypeScript 允许忽略一个 Promise 的解析值，而
 * 今天 components/ 与 app/ 下没有任何地方调用这个 action（只有 createFixedAsset
 * 有表单），所以这里没有静默改变任何页面的行为。
 */
export async function updateFixedAssetAction(
  orgSlug: string,
  id: string,
  input: z.infer<typeof updateFixedAssetSchema>,
): Promise<{ keptPostedPeriods: string[] }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = updateFixedAssetSchema.parse(input);

  const result = await withTransaction(context.userId, async (tx) => {
    const before = await getFixedAsset(tx, context.organizationId, id);
    if (!before) throw new Error('Fixed asset not found.');
    // 处置分录按处置当时的原值与科目出的。之后再改原值或科目，详情页反推的
    // 损益、以及撤销处置后的账面都会与那笔分录对不上。要改就先撤销处置。
    if (!before.isActive) {
      throw new Error('This asset has been disposed. Undo the disposal before editing it.');
    }

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

    assertSalvageWithinCost(
      updates.costMinor ?? before.costMinor,
      updates.salvageValueMinor ?? before.salvageValueMinor,
    );
    await assertAssetAccountsBelongToOrg(tx, context.organizationId, [
      parsed.assetAccountId,
      parsed.depnExpenseAccountId,
      parsed.depnAccumAccountId,
    ]);

    await updateFixedAsset(tx, context.organizationId, id, updates);

    const needsRegen =
      parsed.cost !== undefined ||
      parsed.salvageValue !== undefined ||
      parsed.usefulLifeMonths !== undefined ||
      parsed.method !== undefined ||
      parsed.decliningRateBps !== undefined ||
      parsed.purchaseDate !== undefined;

    let keptPostedPeriods: string[] = [];
    if (needsRegen) {
      ({ keptPostedPeriods } = await generateDepreciationSchedule(tx, context.organizationId, id));
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'fixed_asset.updated',
      entityType: 'fixed_asset',
      entityId: id,
      // before 原来是空的。改资产参数是会改写往后每一期折旧金额的动作，只记
      // after 的话，审计日志回答不了「改之前原值是多少」——而那正是事后对账
      // 时唯一想知道的事。bigint 不能直接进 JSON，统一转字符串（同 postJournal）。
      before: {
        purchaseDate: before.purchaseDate,
        costMinor: before.costMinor.toString(),
        salvageValueMinor: before.salvageValueMinor.toString(),
        usefulLifeMonths: before.usefulLifeMonths,
        method: before.method,
        decliningRateBps: before.decliningRateBps,
      },
      after: {
        ...parsed,
        // 这一条是本次改动里唯一「用户看不见却必须留痕」的事实：哪些期间因为
        // 已经入账而被原样保留。没有它，日后看到排程前后两段金额不一致的人
        // 无从判断那是缺陷还是规则。
        regenerated: needsRegen,
        keptPostedPeriods,
      },
    });

    return { keptPostedPeriods };
  });

  revalidatePath(`/${orgSlug}/fixed-assets`);
  revalidatePath(`/${orgSlug}/fixed-assets/${id}`);
  return result;
}

const disposeFixedAssetSchema = z.object({
  disposalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** 处置收入，本位币十进制字符串；'0' = 报废。 */
  proceeds: z.string().min(1).default('0'),
  /** 收款的资金账户。收入为 0 时可以不填。 */
  moneyAccountId: z.string().uuid().nullable().optional(),
});

/** 处置损益挂的两个科目。按 code 查，缺哪个列哪个，同 resolvePostingAccounts。 */
const DISPOSAL_GAIN_CODE = 'other-income';
const DISPOSAL_LOSS_CODE = 'other-expenses';

async function resolveDisposalAccounts(
  tx: Tx,
  organizationId: string,
): Promise<{ gainAccountId: string; lossAccountId: string }> {
  const [gain, loss] = await Promise.all([
    findAccountByCode(tx, organizationId, DISPOSAL_GAIN_CODE),
    findAccountByCode(tx, organizationId, DISPOSAL_LOSS_CODE),
  ]);
  const missing = [gain ? null : DISPOSAL_GAIN_CODE, loss ? null : DISPOSAL_LOSS_CODE].filter(
    (code): code is string => code !== null,
  );
  if (!gain || !loss) {
    throw new LedgerError(
      `This company is missing the account(s) needed to post this document: ${missing.join(', ')}. ` +
        'Ask an owner or admin to restore them under Settings › Chart of accounts.',
    );
  }
  return { gainAccountId: gain.id, lossAccountId: loss.id };
}

/**
 * 处置一条固定资产（出售或报废），并出一笔处置分录。
 *
 * 原来这里只把 is_active 置为 false：资产原值与累计折旧永远挂在资产负债表上，
 * 处置损益也从未入账——卖掉一台机器，账上它还在，卖得的钱则没有对应的去处。
 *
 * 分录（全部本位币，零金额的行不出）：
 *   借 累计折旧        截至处置日真正入了账的累计折旧
 *   借 资金账户        处置收入（> 0 时）
 *   借 其他费用        处置损失 = 账面净值 - 收入（> 0 时）
 *     贷 资产科目      原值（cost_minor，本位币，见 0011 迁移）
 *     贷 其他收入      处置收益 = 收入 - 账面净值（> 0 时）
 * 过账后这台资产在资产科目与累计折旧科目上的净额都归零。
 *
 * 读 -> 记账 -> 标记，三步同一个事务；期间锁由 postJournal 检查。
 */
export async function disposeFixedAssetAction(
  orgSlug: string,
  id: string,
  input: z.input<typeof disposeFixedAssetSchema>,
): Promise<{ transactionId: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const assetId = z.string().uuid().parse(id);
  const parsed = disposeFixedAssetSchema.parse(input);

  const proceedsMinor = parseAmountMinor(parsed.proceeds, context.baseCurrency);
  const moneyAccountId = proceedsMinor > 0n ? parsed.moneyAccountId ?? null : null;
  if (proceedsMinor > 0n && !moneyAccountId) {
    throw new Error('Choose the account that received the sale proceeds.');
  }

  const result = await withTransaction(context.userId, async (tx) => {
    const pending = await loadDisposalPosting(
      tx,
      context.organizationId,
      assetId,
      parsed.disposalDate,
    );
    if (moneyAccountId) {
      await assertMoneyAccountInOrg(tx, context.organizationId, moneyAccountId);
    }
    const { gainAccountId, lossAccountId } = await resolveDisposalAccounts(
      tx,
      context.organizationId,
    );

    const amounts = {
      costMinor: pending.costMinor,
      accumulatedMinor: pending.accumulatedMinor,
      proceedsMinor,
    };

    const { transactionId } = await postJournal(tx, context, {
      event: {
        type: 'asset-disposal',
        assetAccountId: pending.assetAccountId,
        accumAccountId: pending.depnAccumAccountId,
        proceedsAccountId: moneyAccountId,
        gainAccountId,
        lossAccountId,
        ...amounts,
        amountMinor: assetDisposalTotal(amounts),
      },
      occurredOn: parsed.disposalDate,
      description: `Disposal: ${pending.assetName}`,
      currency: context.baseCurrency,
      // 处置恒为本位币，resolveRate 走同币种那一支，够不到汇率报错。
      manualRateEntry: 'unavailable',
      categoryId: null,
      // 幂等靠的是资产行锁加 is_active（见 loadDisposalPosting），不是它。
      clientUuid: crypto.randomUUID(),
      sourceType: 'fixed_asset',
      sourceId: assetId,
    });

    await markAssetDisposed(tx, context.organizationId, assetId, {
      transactionId,
      proceedsMinor,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'fixed_asset.disposed',
      entityType: 'fixed_asset',
      entityId: assetId,
      before: { isActive: true },
      after: {
        isActive: false,
        disposalDate: parsed.disposalDate,
        disposalTransactionId: transactionId,
        costMinor: pending.costMinor.toString(),
        accumulatedMinor: pending.accumulatedMinor.toString(),
        proceedsMinor: proceedsMinor.toString(),
        moneyAccountId,
      },
    });

    return { transactionId };
  });

  revalidatePath(`/${orgSlug}/fixed-assets`);
  revalidatePath(`/${orgSlug}/fixed-assets/${assetId}`);
  return result;
}

/**
 * 撤销处置：作废处置分录，资产回到在用状态。
 *
 * 作废走 voidDocumentPosting——与作废发票、账单连带作废分录是同一条路，
 * 期间锁检查也在那里。0031 之前的旧处置没有分录，直接恢复即可。
 *
 * 处置分录被作废之后，那几期因处置而不再能过账的折旧又可以过账了：
 * loadDepreciationPosting 只看 is_active。
 */
export async function undoFixedAssetDisposalAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const assetId = z.string().uuid().parse(id);

  await withTransaction(context.userId, async (tx) => {
    // 先锁资产行，与处置共用同一把锁：撤销与再次处置不会交错。
    await tx`
      select id from fixed_assets
      where id = ${assetId} and organization_id = ${context.organizationId}
      for update
    `;
    const existing = await getFixedAsset(tx, context.organizationId, assetId);
    if (!existing) throw new Error('Fixed asset not found.');
    if (existing.isActive) throw new Error('This asset has not been disposed.');

    if (existing.disposalTransactionId) {
      await voidDocumentPosting(tx, context, {
        transactionId: existing.disposalTransactionId,
        reason: `Disposal of ${existing.name} undone`,
      });
    }

    await reactivateDisposedAsset(tx, context.organizationId, assetId);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'fixed_asset.disposal_undone',
      entityType: 'fixed_asset',
      entityId: assetId,
      before: {
        isActive: false,
        disposalTransactionId: existing.disposalTransactionId,
        disposalProceedsMinor: existing.disposalProceedsMinor?.toString() ?? null,
      },
      after: { isActive: true },
    });
  });

  revalidatePath(`/${orgSlug}/fixed-assets`);
  revalidatePath(`/${orgSlug}/fixed-assets/${assetId}`);
  revalidatePath(`/${orgSlug}/transactions`);
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
  // 与处置、撤销处置同一道：两个参数都来自网络，非 uuid / 非日期的串原来
  // 一路交给 Postgres，用户读到的是 22P02 或 date/time 的裸报错。
  z.object({ assetId: z.string().uuid(), period: isoDate }).parse({ assetId, period });

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
