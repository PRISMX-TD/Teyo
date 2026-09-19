'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
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
import {
  RATE_SCALE,
  convertToBaseMinor,
  formatScaledRate,
  parseRateToScaled,
} from '@/server/domain/exchange-rate';
import { sumMinor } from '@/server/domain/money';
// 数量的定标整数解析在库存仓储里（那是它唯一真正被用来算钱的地方，注释也在
// 那里）。po_items.quantity 与 inventory_transactions.quantity 同为
// numeric(12,4)，同一套解析，不在这里再写一份——两份四位小数的解析里改错
// 一份，另一份看不出来。
import { extendQuantity, parseQuantityToScaled } from '@/server/repositories/inventory';

const CURRENCY = z.string().regex(/^[A-Z]{3}$/, 'Currency must be a three-letter code.');
const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 已经是最小货币单位的整数字符串（可含负号由上层业务决定，这里只收非负）。 */
const MINOR = z.string().regex(/^\d+$/, 'Amounts must be whole numbers of minor units.');
/** 数量：十进制字符串或数字，最多四位小数，由 parseQuantityToScaled 兜底校验。 */
const QUANTITY = z.union([z.number(), z.string()]);

const poItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: QUANTITY,
  unitPriceMinor: MINOR,
  amountMinor: MINOR.optional(),
  taxRateId: z.string().uuid().optional(),
});

const createPoSchema = z.object({
  contactId: z.string().uuid(),
  issueDate: DATE_ONLY,
  expectedDate: DATE_ONLY.optional(),
  currency: CURRENCY.optional(),
  /**
   * 汇率是一个**十进制字符串**（'1.5'、'4.35'），不是定标整数。
   *
   * 这里原来写的是 `input.exchangeRate ? BigInt(input.exchangeRate) : RATE_SCALE`，
   * 把用户界面上那个「1 USD = ? MYR」的数直接当成放大 10^8 的整数：
   *   - 传 '1.5'  -> BigInt('1.5') 抛 SyntaxError，用户看到一句 JS 报错；
   *   - 传 '15'   -> 被当成 0.00000015，一张一万块的采购单折成本位币是 0.0015。
   * 后者不报任何错。全项目「字符串 <-> 定标整数」只有 parseRateToScaled /
   * formatScaledRate 这一对实现（0021 迁移的注释里把这条定死了），这里改成走它。
   */
  exchangeRate: z.string().optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(poItemSchema).min(1, 'A purchase order needs at least one line.'),
});

const updatePoSchema = z.object({
  contactId: z.string().uuid().optional(),
  issueDate: DATE_ONLY.optional(),
  expectedDate: DATE_ONLY.optional(),
  currency: CURRENCY.optional(),
  exchangeRate: z.string().optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(poItemSchema).min(1).optional(),
});

const PO_STATUSES = ['draft', 'sent', 'received', 'billed', 'closed', 'voided'] as const;

/**
 * 一张采购单的两个金额：单据币种下的合计，以及折算到本位币之后的合计。
 *
 * purchase_orders 上只有 base_total_minor 一列（0009），列名里的 base 是
 * 「本位币」的意思。原来的代码把单据币种下的合计原样写进去——一张 USD 的
 * 采购单，在一家本位币为 MYR 的公司里，账上记的是「MYR 一万」而实际是
 * 「USD 一万」。这一列今天没有任何报表读它，所以谁也不会发现。
 *
 * 折算走 convertToBaseMinor：它同时处理两边小数位不同的情况（USD 两位、
 * JPY 零位），舍入规则与全项目其余地方同一套。
 */
function totalsFor(
  items: { unitPriceMinor: string; amountMinor?: string; quantity: number | string }[],
  currency: string,
  baseCurrency: string,
  scaledRate: bigint,
): { documentTotalMinor: bigint; baseTotalMinor: bigint; lineAmounts: bigint[] } {
  const lineAmounts = items.map((item) =>
    item.amountMinor !== undefined
      ? BigInt(item.amountMinor)
      : // 原来是 `BigInt(unitPriceMinor) * BigInt(Math.round(quantity))`：
        // 数量先被四舍五入成整数再乘。采购 2.5 吨按 3 吨计价，单据金额与
        // 明细行各自自洽，没有任何地方看得出来。
        extendQuantity(BigInt(item.unitPriceMinor), parseQuantityToScaled(item.quantity)),
  );

  const documentTotalMinor = sumMinor(lineAmounts);

  return {
    documentTotalMinor,
    baseTotalMinor: convertToBaseMinor({
      amountMinor: documentTotalMinor,
      currency,
      baseCurrency,
      scaledRate,
    }),
    lineAmounts,
  };
}

/**
 * 汇率：用户填了就解析，没填就 1。
 *
 * 只有在币种等于本位币时「没填」才等于 1。币种不同却没给汇率的话，
 * convertToBaseMinor 会抛「Exchange rate must be exactly 1 when currency
 * equals base currency」——不对，那一支只在币种相同时触发；币种不同而汇率
 * 为 1 会静默地按 1:1 折算。所以这里必须自己挡：与 resolveRate 拒绝回退 1:1
 * 是同一条规矩，宁可当场报错，也不写一个事后看不出来的数。
 *
 * 不去查 exchange_rates 缓存：采购单表单上没有汇率输入框（见
 * components/purchase-orders/po-form.tsx），而 resolveRate 的缓存回溯只有
 * 7 天、cron 只同步「今天」，补一张上个月的采购单十有八九查不到。要接缓存
 * 得先给表单加一个能填汇率的地方，那属于前端。
 */
function resolvePoRate(
  exchangeRate: string | undefined,
  currency: string,
  baseCurrency: string,
): bigint {
  if (exchangeRate !== undefined && exchangeRate !== '') {
    return parseRateToScaled(exchangeRate);
  }
  if (currency !== baseCurrency) {
    throw new Error(
      `Enter the ${currency} to ${baseCurrency} rate for this purchase order.`,
    );
  }
  return RATE_SCALE;
}

/**
 * 建一张采购单。
 *
 * 权限从 account:manage 调成 transaction:create。
 *
 * 原来三个同类模块用三种权限：采购单 account:manage（owner/admin）、
 * 发票 transaction:read（连 viewer 都有）、收款 transaction:create。三种写法
 * 没有任何一种说得出理由，而其中「开发票只要 transaction:read」是实打实的
 * 缺陷——只读用户开得出发票。采购单这一头则是反过来：记账员的日常工作就是
 * 录采购单，却被 account:manage（只有 owner/admin）挡在外面。
 *
 * 选 transaction:create 而不是别的：建一张采购单与记一笔交易是同一类动作，
 * 而 transaction:create 的角色集合正好是 owner/admin/bookkeeper。
 */
export async function createPurchaseOrder(
  orgSlug: string,
  input: z.input<typeof createPoSchema>,
): Promise<{ id: string; poNumber: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');
  const parsed = createPoSchema.parse(input);

  // 币种缺省取本位币，不是 'USD'。
  //
  // 0009 给这批表的 currency 列写的默认值就是 'USD'，而 organizations 的
  // 默认时区是 Asia/Kuala_Lumpur——默认值指向的市场从一开始就对不上。
  // 0021 把这些列的 default 去掉了，并在注释里写明「默认值改由应用侧传本位币」，
  // 这里就是那一句的落点。
  const currency = parsed.currency ?? context.baseCurrency;
  const scaledRate = resolvePoRate(parsed.exchangeRate, currency, context.baseCurrency);

  const result = await withTransaction(context.userId, async (tx) => {
    const poNumber = await getNextPoNumber(tx, context.organizationId);

    const { documentTotalMinor, baseTotalMinor, lineAmounts } = totalsFor(
      parsed.items,
      currency,
      context.baseCurrency,
      scaledRate,
    );

    const { id } = await insertPurchaseOrder(tx, {
      organizationId: context.organizationId,
      contactId: parsed.contactId,
      poNumber,
      issueDate: parsed.issueDate,
      expectedDate: parsed.expectedDate,
      currency,
      exchangeRate: scaledRate,
      baseTotalMinor,
      notes: parsed.notes,
      createdBy: context.userId,
    });

    await insertPoItems(
      tx,
      parsed.items.map((item, index) => ({
        poId: id,
        description: item.description,
        quantityScaled: parseQuantityToScaled(item.quantity),
        unitPriceMinor: BigInt(item.unitPriceMinor),
        amountMinor: lineAmounts[index],
        taxRateId: item.taxRateId,
      })),
    );

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'purchase_order.created',
      entityType: 'purchase_order',
      entityId: id,
      after: {
        poNumber,
        contactId: parsed.contactId,
        issueDate: parsed.issueDate,
        currency,
        // bigint 不能直接进 JSON，统一转字符串（同 postJournal）。
        exchangeRate: formatScaledRate(scaledRate),
        documentTotalMinor: documentTotalMinor.toString(),
        baseTotalMinor: baseTotalMinor.toString(),
        itemCount: parsed.items.length,
      },
    });

    return { id, poNumber };
  });

  // 路由段叫 purchase-orders（见 app/(app)/[orgSlug]/），不是 purchases。
  // 原来刷的是后者——一个不存在的路径，刷了等于没刷。
  revalidatePath(`/${orgSlug}/purchase-orders`);
  return result;
}

/**
 * 改一张采购单。权限 transaction:edit:any（owner/admin）。
 *
 * 不是 transaction:edit:own：purchase_orders 上虽然有 created_by，但
 * canEditTransaction 那套「自己建的可以改」只在 transactions 上实现过，
 * 这里照搬会多出第二份判定。要放宽给记账员，应当和其余单据一起放宽（见
 * server/domain/permissions.ts 里新加的 document:edit），而不是由这一个
 * action 自己决定。
 */
export async function updatePurchaseOrderAction(
  orgSlug: string,
  id: string,
  input: z.input<typeof updatePoSchema>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');
  const parsed = updatePoSchema.parse(input);

  await withTransaction(context.userId, async (tx) => {
    const before = await getPurchaseOrder(tx, context.organizationId, id);
    if (!before) throw new Error('Purchase order not found.');

    // 币种与汇率任一没给就沿用这张单原来的。原来的写法是「没给就不改」，
    // 但金额换算必须知道这两个值，缺一个就只能猜——猜出来的结果是
    // base_total_minor 按另一个汇率算，而 exchange_rate 列上写的是旧的。
    const currency = parsed.currency ?? before.currency;
    const scaledRate =
      parsed.exchangeRate !== undefined && parsed.exchangeRate !== ''
        ? parseRateToScaled(parsed.exchangeRate)
        : parsed.currency !== undefined && parsed.currency !== before.currency
          ? resolvePoRate(undefined, currency, context.baseCurrency)
          : before.exchangeRate;

    const totals = parsed.items
      ? totalsFor(parsed.items, currency, context.baseCurrency, scaledRate)
      : null;

    await updatePurchaseOrder(tx, context.organizationId, id, {
      contactId: parsed.contactId,
      issueDate: parsed.issueDate,
      expectedDate: parsed.expectedDate,
      currency,
      exchangeRate: scaledRate,
      // 明细没重传时，币种/汇率仍可能变了——那时旧的单据币种合计要按新汇率
      // 重新折算一次，否则 base_total_minor 会停留在旧汇率的口径上。
      baseTotalMinor:
        totals?.baseTotalMinor ??
        convertToBaseMinor({
          amountMinor: sumMinor(before.items.map((item) => item.amountMinor)),
          currency,
          baseCurrency: context.baseCurrency,
          scaledRate,
        }),
      notes: parsed.notes,
    });

    if (parsed.items && totals) {
      await deletePoItems(tx, id);
      await insertPoItems(
        tx,
        parsed.items.map((item, index) => ({
          poId: id,
          description: item.description,
          quantityScaled: parseQuantityToScaled(item.quantity),
          unitPriceMinor: BigInt(item.unitPriceMinor),
          amountMinor: totals.lineAmounts[index],
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
      before: {
        poNumber: before.poNumber,
        contactId: before.contactId,
        issueDate: before.issueDate,
        currency: before.currency,
        exchangeRate: formatScaledRate(before.exchangeRate),
        baseTotalMinor: before.baseTotalMinor.toString(),
        itemCount: before.items.length,
      },
      after: {
        contactId: parsed.contactId ?? before.contactId,
        issueDate: parsed.issueDate ?? before.issueDate,
        currency,
        exchangeRate: formatScaledRate(scaledRate),
        baseTotalMinor: (totals?.baseTotalMinor ?? before.baseTotalMinor).toString(),
        itemCount: parsed.items?.length ?? before.items.length,
      },
    });
  });

  revalidatePath(`/${orgSlug}/purchase-orders`);
  revalidatePath(`/${orgSlug}/purchase-orders/${id}`);
}

/**
 * 改一张采购单的状态。权限与编辑同为 transaction:edit:any。
 *
 * 'voided' 顺带写 voided_at。原来只改 status，于是一张作废的采购单
 * status = 'voided' 而 voided_at 仍是 null——而 listPurchaseOrders 与
 * 0021 之后的每一处「排除作废单据」用的都是 voided_at。同一件事有两处
 * 记号，其中一处从来没人写，就等于那处记号永远说「没作废」。
 */
export async function setPoStatusAction(
  orgSlug: string,
  id: string,
  status: (typeof PO_STATUSES)[number],
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');
  const parsedStatus = z.enum(PO_STATUSES).parse(status);

  await withTransaction(context.userId, async (tx) => {
    const before = await getPurchaseOrder(tx, context.organizationId, id);
    if (!before) throw new Error('Purchase order not found.');

    await setPoStatus(tx, context.organizationId, id, parsedStatus);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'purchase_order.status_changed',
      entityType: 'purchase_order',
      entityId: id,
      before: { status: before.status, voidedAt: before.voidedAt },
      after: { status: parsedStatus },
    });
  });

  revalidatePath(`/${orgSlug}/purchase-orders`);
  revalidatePath(`/${orgSlug}/purchase-orders/${id}`);
}
