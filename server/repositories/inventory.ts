import type { Tx } from '@/server/db/transaction';

export type InventoryItemRow = {
  id: string;
  organizationId: string;
  sku: string;
  nameEn: string;
  nameZh: string;
  unit: string;
  costMethod: 'fifo' | 'average';
  currentQuantity: number;
  currentAvgCostMinor: bigint;
  reorderLevel: number;
  cogsAccountId: string | null;
  inventoryAccountId: string | null;
  isActive: boolean;
  createdAt: string;
};

export type InventoryTransactionRow = {
  id: string;
  organizationId: string;
  inventoryItemId: string;
  type: 'purchase' | 'sale' | 'adjustment' | 'return';
  quantity: number;
  unitCostMinor: bigint;
  totalCostMinor: bigint;
  referenceType: string | null;
  referenceId: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string;
};

export async function listInventoryItems(tx: Tx, organizationId: string): Promise<InventoryItemRow[]> {
  const rows = await tx`
    select id, organization_id, sku, name_en, name_zh, unit, cost_method,
           current_quantity, current_avg_cost_minor, reorder_level,
           cogs_account_id, inventory_account_id, is_active, created_at
    from inventory_items
    where organization_id = ${organizationId}
    order by name_en
  `;
  return rows.map(mapItem);
}

export async function getInventoryItem(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<InventoryItemRow | null> {
  const rows = await tx`
    select id, organization_id, sku, name_en, name_zh, unit, cost_method,
           current_quantity, current_avg_cost_minor, reorder_level,
           cogs_account_id, inventory_account_id, is_active, created_at
    from inventory_items
    where id = ${id} and organization_id = ${organizationId}
  `;
  return rows.length ? mapItem(rows[0]) : null;
}

export async function getInventoryItemWithRecentTxns(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<{ item: InventoryItemRow; recentTransactions: InventoryTransactionRow[] } | null> {
  const item = await getInventoryItem(tx, organizationId, id);
  if (!item) return null;

  const txnRows = await tx`
    select id, organization_id, inventory_item_id, type, quantity,
           unit_cost_minor, total_cost_minor, reference_type, reference_id,
           notes, created_at, created_by
    from inventory_transactions
    where inventory_item_id = ${id} and organization_id = ${organizationId}
    order by created_at desc
    limit 20
  `;

  return {
    item,
    recentTransactions: txnRows.map(mapTransaction),
  };
}

export async function insertInventoryItem(
  tx: Tx,
  row: {
    organizationId: string;
    sku: string;
    nameEn: string;
    nameZh: string;
    unit: string;
    costMethod: 'fifo' | 'average';
    reorderLevel: number;
    cogsAccountId?: string;
    inventoryAccountId?: string;
  },
): Promise<{ id: string }> {
  const r = await tx`
    insert into inventory_items (
      organization_id, sku, name_en, name_zh, unit, cost_method,
      reorder_level, cogs_account_id, inventory_account_id
    )
    values (
      ${row.organizationId}, ${row.sku}, ${row.nameEn}, ${row.nameZh},
      ${row.unit}, ${row.costMethod}, ${row.reorderLevel},
      ${row.cogsAccountId ?? null}, ${row.inventoryAccountId ?? null}
    )
    returning id
  `;
  return { id: r[0].id as string };
}

export async function updateInventoryItem(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: Partial<{
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
  await tx`
    update inventory_items set
      sku = coalesce(${fields.sku ?? null}, sku),
      name_en = coalesce(${fields.nameEn ?? null}, name_en),
      name_zh = coalesce(${fields.nameZh ?? null}, name_zh),
      unit = coalesce(${fields.unit ?? null}, unit),
      cost_method = coalesce(${fields.costMethod ?? null}::cost_method, cost_method),
      reorder_level = coalesce(${fields.reorderLevel ?? null}, reorder_level),
      cogs_account_id = ${fields.cogsAccountId ?? null},
      inventory_account_id = ${fields.inventoryAccountId ?? null}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function setItemActive(
  tx: Tx,
  organizationId: string,
  id: string,
  active: boolean,
): Promise<void> {
  await tx`
    update inventory_items set is_active = ${active}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export type RecordInventoryTxnInput = {
  inventoryItemId: string;
  type: 'purchase' | 'sale' | 'adjustment' | 'return';
  quantity: number;
  unitCostMinor: bigint;
  referenceType?: string;
  referenceId?: string;
  notes?: string;
  createdBy: string;
};

/**
 * 记录一笔库存交易，同时更新 inventory_items 的 current_quantity 和
 * current_avg_cost_minor（仅 average 成本法）。
 *
 * 购买 / 退货：数量增加，重算平均成本
 * 销售：数量减少
 * 调整：直接设置数量
 */
export async function recordInventoryTransaction(
  tx: Tx,
  organizationId: string,
  input: RecordInventoryTxnInput,
): Promise<{ id: string; newQuantity: number; newAvgCostMinor: bigint }> {
  const totalCostMinor = BigInt(Math.round(input.quantity * Number(input.unitCostMinor)));

  const txnResult = await tx`
    insert into inventory_transactions (
      organization_id, inventory_item_id, type, quantity,
      unit_cost_minor, total_cost_minor, reference_type, reference_id,
      notes, created_by
    )
    values (
      ${organizationId}, ${input.inventoryItemId}, ${input.type},
      ${input.quantity}, ${input.unitCostMinor.toString()},
      ${totalCostMinor.toString()},
      ${input.referenceType ?? null}, ${input.referenceId ?? null},
      ${input.notes ?? null}, ${input.createdBy}
    )
    returning id
  `;

  // 读取当前库存状态
  const [item] = await tx`
    select current_quantity, current_avg_cost_minor, cost_method
    from inventory_items
    where id = ${input.inventoryItemId} and organization_id = ${organizationId}
  `;

  const currentQty = Number(item.current_quantity);
  const currentAvgCost = BigInt(item.current_avg_cost_minor);
  const costMethod = item.cost_method as 'fifo' | 'average';

  let newQty: number;
  let newAvgCost: bigint = currentAvgCost;

  if (input.type === 'purchase' || input.type === 'return') {
    // 入库：数量增加
    newQty = currentQty + input.quantity;

    // 平均成本法：重算加权平均
    if (costMethod === 'average' && newQty !== 0) {
      const totalValue = currentAvgCost * BigInt(Math.round(currentQty));
      const txnValue = input.unitCostMinor * BigInt(Math.round(input.quantity));
      newAvgCost = (totalValue + txnValue) / BigInt(Math.round(newQty));
    } else if (currentQty === 0) {
      newAvgCost = input.unitCostMinor;
    }
  } else if (input.type === 'sale') {
    // 出库：数量减少
    newQty = currentQty - input.quantity;
    // 平均成本不变
  } else {
    // adjustment：直接设置数量
    newQty = input.quantity;
    if (newQty < 0) newQty = 0;
    if (newQty === 0) {
      newAvgCost = 0n;
    } else if (costMethod === 'average' && newQty !== 0) {
      newAvgCost = input.unitCostMinor;
    }
  }

  await tx`
    update inventory_items
    set current_quantity = ${newQty},
        current_avg_cost_minor = ${newAvgCost.toString()}
    where id = ${input.inventoryItemId} and organization_id = ${organizationId}
  `;

  return {
    id: txnResult[0].id as string,
    newQuantity: newQty,
    newAvgCostMinor: newAvgCost,
  };
}

export type InventoryValuationRow = {
  itemId: string;
  sku: string;
  nameEn: string;
  nameZh: string;
  unit: string;
  quantity: number;
  avgCostMinor: bigint;
  totalValueMinor: bigint;
};

export async function getInventoryValuation(
  tx: Tx,
  organizationId: string,
): Promise<InventoryValuationRow[]> {
  const rows = await tx`
    select id, sku, name_en, name_zh, unit, current_quantity,
           current_avg_cost_minor
    from inventory_items
    where organization_id = ${organizationId} and is_active = true
    order by name_en
  `;

  return rows.map((row) => {
    const qty = Number(row.current_quantity);
    const avgCost = BigInt(row.current_avg_cost_minor);
    const totalValue = avgCost * BigInt(Math.round(qty));

    return {
      itemId: row.id as string,
      sku: row.sku as string,
      nameEn: row.name_en as string,
      nameZh: row.name_zh as string,
      unit: row.unit as string,
      quantity: qty,
      avgCostMinor: avgCost,
      totalValueMinor: totalValue,
    };
  });
}

/** 库存水平 <= 再订购点的物品 */
export async function getLowStockItems(
  tx: Tx,
  organizationId: string,
): Promise<InventoryItemRow[]> {
  const rows = await tx`
    select id, organization_id, sku, name_en, name_zh, unit, cost_method,
           current_quantity, current_avg_cost_minor, reorder_level,
           cogs_account_id, inventory_account_id, is_active, created_at
    from inventory_items
    where organization_id = ${organizationId}
      and is_active = true
      and current_quantity <= reorder_level
    order by name_en
  `;
  return rows.map(mapItem);
}

function mapItem(row: Record<string, unknown>): InventoryItemRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    sku: row.sku as string,
    nameEn: row.name_en as string,
    nameZh: row.name_zh as string,
    unit: row.unit as string,
    costMethod: row.cost_method as 'fifo' | 'average',
    currentQuantity: Number(row.current_quantity),
    currentAvgCostMinor: BigInt(row.current_avg_cost_minor as string),
    reorderLevel: Number(row.reorder_level),
    cogsAccountId: (row.cogs_account_id as string | null) ?? null,
    inventoryAccountId: (row.inventory_account_id as string | null) ?? null,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as string),
  };
}

function mapTransaction(row: Record<string, unknown>): InventoryTransactionRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    inventoryItemId: row.inventory_item_id as string,
    type: row.type as 'purchase' | 'sale' | 'adjustment' | 'return',
    quantity: Number(row.quantity),
    unitCostMinor: BigInt(row.unit_cost_minor as string),
    totalCostMinor: BigInt(row.total_cost_minor as string),
    referenceType: (row.reference_type as string | null) ?? null,
    referenceId: (row.reference_id as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    createdAt: (row.created_at as string),
    createdBy: row.created_by as string,
  };
}
