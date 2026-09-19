'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission, todayInOrg } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { LedgerError } from '@/server/domain/ledger';
import { postJournal } from '@/server/posting/post-journal';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  getInventoryItem,
  insertInventoryItem,
  updateInventoryItem,
  setItemActive,
  recordInventoryTransaction,
  parseQuantityToScaled,
  formatScaledQuantity,
} from '@/server/repositories/inventory';
import {
  POSTING_ACCOUNT_CODES,
  requireAccount,
  resolvePostingAccounts,
} from '@/server/services/posting-accounts';

export async function createInventoryItem(
  orgSlug: string,
  input: {
    sku: string;
    nameEn: string;
    nameZh: string;
    unit: string;
    costMethod: 'fifo' | 'average';
    /** 再订购点。与数量同为 numeric(12,4)，字符串写法可以带四位小数。 */
    reorderLevel?: number | string;
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
      reorderLevelScaled: parseQuantityToScaled(input.reorderLevel ?? 0),
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
    reorderLevel: number | string;
    cogsAccountId: string;
    inventoryAccountId: string;
  }>,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getInventoryItem(tx, context.organizationId, id);

    await updateInventoryItem(tx, context.organizationId, id, {
      sku: input.sku,
      nameEn: input.nameEn,
      nameZh: input.nameZh,
      unit: input.unit,
      costMethod: input.costMethod,
      reorderLevelScaled:
        input.reorderLevel === undefined ? undefined : parseQuantityToScaled(input.reorderLevel),
      cogsAccountId: input.cogsAccountId,
      inventoryAccountId: input.inventoryAccountId,
    });

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

/**
 * 库存变动的对方科目。
 *
 * 入库（purchase）贷「进货」：进货那笔钱在用户录支出/账单时已经进过费用，
 * 这一步把它从费用重分类到存货资产，所以贷的是当初借的那个科目，而不是
 * 现金或应付——否则同一笔采购会在账上出现两次。
 *
 * 出库（sale）借销货成本；销售退回（return）与盘点调整（adjustment）走同一
 * 个科目的反向，因为它们冲的正是当初结转出去的那笔成本。
 *
 * 物料上没有配 cogs_account_id 时，退回公司的 'cogs' 科目（种子科目，
 * 0021 已给既有公司回填）。**不再退回 purchases**：那会让销货成本与进货
 * 挤在同一个科目里，毛利率就算不出来了——进货多的月份看起来在亏钱、
 * 清库存的月份看起来暴利，而两个月的账都完全配平。
 */
function contraAccountFor(
  type: 'purchase' | 'sale' | 'adjustment' | 'return',
  cogsAccountId: string | null,
  purchasesAccountId: string,
  defaultCogsAccountId: string,
): string {
  if (type === 'purchase') return purchasesAccountId;
  return cogsAccountId ?? defaultCogsAccountId;
}

export async function recordInventoryTxnAction(
  orgSlug: string,
  input: {
    inventoryItemId: string;
    type: 'purchase' | 'sale' | 'adjustment' | 'return';
    /**
     * 数量。字符串是推荐写法（精确到四位小数，与 numeric(12,4) 一致）；
     * number 是过渡期兼容 components/settings/inventory-list.tsx 今天传的
     * `parseFloat(...) || 0`，解析时不做浮点乘法，见 parseQuantityToScaled。
     */
    quantity: number | string;
    /** 单价，最小货币单位。与本位币同币种——库存表上没有币种列。 */
    unitCostMinor: string;
    /**
     * 这笔变动记在哪一天。缺省取**这家公司所在时区的今天**（todayInOrg），
     * 不是 `new Date().toISOString().slice(0, 10)` 那个 UTC 的今天：对一家
     * UTC+8 的公司，每天本地 00:00–08:00 这八个小时里后者给的是昨天，
     * 而这个日期直接决定期间锁怎么判、这笔存货进哪个月的报表。
     */
    occurredOn?: string;
    referenceType?: string;
    referenceId?: string;
    notes?: string;
  },
): Promise<{
  id: string;
  newQuantity: number;
  newQuantityScaled: string;
  newAvgCostMinor: string;
  /** 本次产生的记账凭证；价值没有变化时为 null（不写一笔金额为零的分录）。 */
  transactionId: string | null;
}> {
  // 这里维持 account:manage（owner/admin），不跟着单据类改成 transaction:create。
  //
  // 理由不是权限洁癖：这个动作除了往 inventory_transactions 写一行，还必须
  // UPDATE inventory_items 的数量与平均成本，而 inventory_items 在
  // server/domain/permissions.ts 的 TABLE_ACCESS 里是 masterdata:manage
  // （owner/admin），inventory_transactions 才是 document:create（记账员也有）。
  // 放宽到 transaction:create 会让记账员通过应用层，然后在那句 UPDATE 上被 RLS
  // 挡掉——而 UPDATE 被 RLS 挡掉不报错，只是匹配零行：流水记下了、库存数量没变。
  // 这个不一致已在交付报告里列出，要么给 inventory_items 放宽，要么维持现状，
  // 不能由这一个 action 单方面决定。
  const context = await requirePermission(orgSlug, 'account:manage');

  const quantityScaled = parseQuantityToScaled(input.quantity);
  const occurredOn = input.occurredOn ?? todayInOrg(context);

  const result = await withTransaction(context.userId, async (tx) => {
    const recorded = await recordInventoryTransaction(tx, context.organizationId, {
      inventoryItemId: input.inventoryItemId,
      type: input.type,
      quantityScaled,
      unitCostMinor: BigInt(input.unitCostMinor),
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      notes: input.notes,
      createdBy: context.userId,
    });

    // ------------------------------------------------------------
    // 进总账
    // ------------------------------------------------------------
    // 这一段是这次新加的。在此之前，inventory_transactions 与加权平均成本是
    // 一套自成体系的数字，一行分录都不产生：库存页面上摆着货值，资产负债表
    // 上的「存货」科目恒为 0。同一个产品里两个页面互相否认对方，与应收账龄
    // 表和资产负债表当初的关系一模一样。
    //
    // 走的是 postJournal——记账凭证的唯一写入出口（eslint.config.mjs 有两条
    // 规则让直接导入 server/posting/insert 变成 lint 错误）。金额取的是存货
    // **价值的变化量**，方向由它的正负决定，见仓储里 valueDeltaMinor 的注释。
    let transactionId: string | null = null;
    if (recorded.valueDeltaMinor !== 0n) {
      if (!recorded.inventoryAccountId) {
        // 当场报错，而不是「记了数量、没记账」。后者会让存货科目继续停在 0，
        // 而用户看到的是保存成功——正是这次要根除的那种失败模式。
        // 科目在 库存设置页 的每个物料上就能选（inventory_items.inventory_account_id）。
        throw new LedgerError(
          `Inventory item "${recorded.itemName}" has no inventory account configured. ` +
            'Set one under Settings › Inventory before recording stock movements.',
        );
      }

      const accounts = await resolvePostingAccounts(tx, context.organizationId, [
        POSTING_ACCOUNT_CODES.purchases,
        POSTING_ACCOUNT_CODES.cogs,
      ]);
      const contraAccountId = contraAccountFor(
        input.type,
        recorded.cogsAccountId,
        requireAccount(accounts, POSTING_ACCOUNT_CODES.purchases),
        requireAccount(accounts, POSTING_ACCOUNT_CODES.cogs),
      );

      const increase = recorded.valueDeltaMinor > 0n;
      const amountMinor = increase ? recorded.valueDeltaMinor : -recorded.valueDeltaMinor;

      const posted = await postJournal(tx, context, {
        event: {
          type: 'journal',
          // 入库：借存货 / 贷进货（或销货成本）。出库：借销货成本 / 贷存货。
          debitAccountId: increase ? recorded.inventoryAccountId : contraAccountId,
          creditAccountId: increase ? contraAccountId : recorded.inventoryAccountId,
          amountMinor,
        },
        occurredOn,
        description: `Inventory ${input.type}: ${recorded.itemName}`,
        // 库存表上没有币种列，单价本来就是本位币最小单位。同币种时
        // resolveRate 直接返回 1，不查缓存。
        currency: context.baseCurrency,
        // 库存对话框上没有任何填汇率的地方。
        manualRateEntry: 'unavailable',
        categoryId: null,
        // 每次点击都是新的 clientUuid，所以 postJournal 自己那道幂等查询在这条
        // 路径上命中不了。inventory_transactions 上也没有幂等键——双击会记两笔
        // 库存流水加两笔分录，两者仍然互相一致。这条缺口已在交付报告中列出，
        // 修它需要一条迁移（给 inventory_transactions 加 client_uuid 唯一索引）。
        clientUuid: crypto.randomUUID(),
        sourceType: 'inventory_transaction',
        sourceId: recorded.id,
      });
      transactionId = posted.transactionId;
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'inventory_transaction.recorded',
      entityType: 'inventory_transaction',
      entityId: recorded.id,
      after: {
        inventoryItemId: input.inventoryItemId,
        type: input.type,
        // bigint 不能直接进 JSON，统一转字符串（同 postJournal）。数量记的是
        // 解析之后的四位小数写法，而不是调用方传来的那个 double——审计要留下
        // 的是落库的那个数。
        quantity: formatScaledQuantity(quantityScaled),
        unitCostMinor: input.unitCostMinor,
        occurredOn,
        newQuantity: formatScaledQuantity(recorded.newQuantityScaled),
        newAvgCostMinor: recorded.newAvgCostMinor.toString(),
        valueDeltaMinor: recorded.valueDeltaMinor.toString(),
        transactionId,
      },
    });

    return {
      id: recorded.id,
      // newQuantity 是给界面显示用的 double，保留是因为
      // components/settings/inventory-list.tsx 今天把它塞回 InventoryItemRow
      // 的 currentQuantity（number）。精确值在 newQuantityScaled 里，任何算术
      // 都该用那一个。
      newQuantity: Number(formatScaledQuantity(recorded.newQuantityScaled)),
      newQuantityScaled: recorded.newQuantityScaled.toString(),
      newAvgCostMinor: recorded.newAvgCostMinor.toString(),
      transactionId,
    };
  });

  // 路径是 /settings/inventory，不是 /inventory。原来这三个 action 刷的都是
  // `/${orgSlug}/inventory`，而 app/(app)/[orgSlug]/ 下没有 inventory 这个
  // 路由段（库存在 settings/inventory 下）——刷一个不存在的路径是空操作，
  // 于是改完库存回到列表页看到的一直是缓存里的旧数字。
  revalidatePath(`/${orgSlug}/settings/inventory`);
  // 存货进了总账，报表与交易列表跟着变。
  revalidatePath(`/${orgSlug}/reports`);
  revalidatePath(`/${orgSlug}/transactions`);
  return result;
}

