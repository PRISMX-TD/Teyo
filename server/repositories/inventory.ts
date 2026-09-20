import type { Tx } from '@/server/db/transaction';
import { MoneyError } from '@/server/domain/money';

/**
 * ============================================================
 * 数量的定标整数
 * ============================================================
 * inventory_items.current_quantity / inventory_transactions.quantity 都是
 * numeric(12,4)（见 0009 迁移），也就是四位小数。这里把数量一律按「放大
 * 10^4 的整数」处理，与金额按 minor units 处理是同一种做法。
 *
 * 为什么不复用 money.ts 的 parseDecimalToMinor / currencyExponent：
 * 那一对函数里的 exponent 是**货币的最小单位位数**，由币种决定（MYR 是 2，
 * JPY 是 0）。数量的 scale 是**列定义的小数位数**，由 numeric(12,4) 决定，
 * 与任何币种无关。把它们混用，最直接的后果是一家本位币为 JPY 的公司
 * （currencyExponent('JPY') === 0）会把 0.5 kg 解析成 0（甚至抛「小数位过多」），
 * 而这条路径与币种根本没有关系。两个概念同名不同义，共用一个函数只会让
 * 下一个人以为改 exponent 是安全的。
 *
 * 舍入只有一套：`(numerator * 2 + denominator) / (denominator * 2)`，与
 * server/domain/exchange-rate.ts 的 convertToBaseMinor 里那一句逐字相同
 * （BigInt 除法向零截断，这个式子等价于对 numerator/denominator 四舍五入、
 * .5 进位）。之所以是复制而不是 import：convertToBaseMinor 的签名讲的是
 * 币种换算（currency / baseCurrency / scaledRate，还要按两边的 exponent 差
 * 调整分子分母），数量乘单价套不进去。复制的是那一个表达式，不是第二套规则。
 */
const QUANTITY_SCALE = 4;
const QUANTITY_UNIT = 10n ** BigInt(QUANTITY_SCALE);

/** 四舍五入（.5 进位）的整数除法。见上面关于「只有一套舍入」的说明。 */
function roundedDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new MoneyError('Cannot divide by zero while valuing inventory.');
  }
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * 数量 -> 放大 10^4 的整数。
 *
 * 接受字符串（推荐）或 number（过渡期）。number 这一支存在的唯一原因是
 * components/settings/inventory-list.tsx 今天传的是 `parseFloat(...) || 0`，
 * 而那个文件不在本次改动范围内。它不做浮点乘法：先用 toString() 拿到该
 * double 的最短往返十进制表示，再走与字符串完全相同的那条解析路径，于是
 * `0.1` 得到的是 1000 而不是 `Math.round(0.1 * 10000)` 那种「碰巧对」的结果。
 *
 * 超过四位小数一律抛错，不静默截断——numeric(12,4) 存不下的那一位，
 * 用户在界面上看到的是「保存成功」，库里是另一个数。
 */
export function parseQuantityToScaled(input: string | number): bigint {
  const raw = typeof input === 'number' ? numberToPlainDecimal(input) : input;
  const normalized = raw.trim().replace(/,/g, '');

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new MoneyError(`Not a valid quantity: ${raw}`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > QUANTITY_SCALE) {
    throw new MoneyError(
      `Quantity ${raw} has more than ${QUANTITY_SCALE} decimal place(s).`,
    );
  }

  const magnitude = BigInt(`${whole}${fraction.padEnd(QUANTITY_SCALE, '0')}`);
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * double -> 平铺的十进制字符串。
 *
 * Number.prototype.toString() 在 1e21 以上和 1e-7 以下会给出指数写法
 * （'1e+21' / '1e-7'），直接喂给上面那个正则会当成非法输入抛错——这正是
 * 想要的结果：numeric(12,4) 的上限是 99999999.9999，1e21 本来就存不下；
 * 1e-7 有七位小数，也不该被悄悄抹成 0。所以这里只负责拒绝 NaN/Infinity，
 * 其余交给解析那一步去判。
 */
function numberToPlainDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Not a valid quantity: ${value}`);
  }
  return value.toString();
}

/** 放大 10^4 的整数 -> 写进 numeric(12,4) 的十进制字符串。全程不经 Number。 */
export function formatScaledQuantity(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(QUANTITY_SCALE + 1, '0');
  const whole = digits.slice(0, digits.length - QUANTITY_SCALE);
  const fraction = digits.slice(digits.length - QUANTITY_SCALE);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * 数量 × 单价 -> 金额（minor units）。
 *
 * 这里原来写的是
 *   `BigInt(Math.round(input.quantity * Number(input.unitCostMinor)))`
 * 三处都不能要：`Number(bigint)` 在金额超过 2^53 时静默丢精度；浮点乘法
 * 本身就不精确；Math.round 之后再转回 BigInt，整条链路里没有任何一步会报错。
 * 改成定标整数相乘再一次性舍入，全程不经 double。
 */
export function extendQuantity(unitCostMinor: bigint, quantityScaled: bigint): bigint {
  return roundedDiv(unitCostMinor * quantityScaled, QUANTITY_UNIT);
}

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
    /** 放大 10^4 的再订购点。reorder_level 与 current_quantity 同为 numeric(12,4)。 */
    reorderLevelScaled: bigint;
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
      ${row.unit}, ${row.costMethod},
      ${formatScaledQuantity(row.reorderLevelScaled)}::numeric,
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
    reorderLevelScaled: bigint;
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
      reorder_level = coalesce(
        ${fields.reorderLevelScaled === undefined
          ? null
          : formatScaledQuantity(fields.reorderLevelScaled)}::numeric,
        reorder_level
      ),
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
  /** 放大 10^4 的数量。由 action 用 parseQuantityToScaled 解析，绝不收 double。 */
  quantityScaled: bigint;
  unitCostMinor: bigint;
  referenceType?: string;
  referenceId?: string;
  notes?: string;
  createdBy: string;
};

export type RecordedInventoryTxn = {
  id: string;
  newQuantityScaled: bigint;
  newAvgCostMinor: bigint;
  /**
   * 本次变动带来的存货价值变化（本位币 minor）：> 0 入库、< 0 出库、= 0 不动。
   *
   * 这个数就是要进总账的金额，由调用方交给 postJournal（记账凭证的唯一写入
   * 出口，见 server/posting/post-journal.ts）。仓储自己不写任何一行分录。
   */
  valueDeltaMinor: bigint;
  /** 物料上配置的两个科目。缺哪个、怎么办由 action 决定，仓储不替它判断。 */
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  itemName: string;
};

/**
 * 记一笔库存变动，并把物料上的数量与加权平均成本改成变动后的样子。
 *
 * 全部算术都是 bigint。原来这里有三处浮点：
 *   1. `BigInt(Math.round(quantity * Number(unitCostMinor)))` —— Number(bigint)
 *      在金额超过 2^53 时静默失真，浮点乘法本身也不精确。
 *   2. `currentAvgCost * BigInt(Math.round(currentQty))` —— 把**小数数量**
 *      先四舍五入再算加权平均。0.5 kg 的在库直接变 1 kg，而列是 numeric(12,4)，
 *      小数数量正是它存在的理由。
 *   3. `/ BigInt(Math.round(newQty))` —— 同上，分母也被取整。
 * 三处都只在「数量带小数」或「金额很大」时出错，账面不会有任何提示。
 *
 * 出库的成本按**加权平均**结转，不按调用方传进来的单价。
 *
 * 界面上「销售」这一栏也让用户填单价（见 components/settings/inventory-list.tsx），
 * 而卖出去的东西值多少钱由进价决定，不由售价决定——用售价冲减存货，最后一件
 * 卖完时存货科目上会剩下一个清不掉的差额，恰好等于历年毛利。售价属于发票，
 * 不属于库存流水。所以这里把 sale 的 unit_cost_minor 与 total_cost_minor 一并
 * 记成结转时的平均成本，让这一行自洽（数量 × 单价 = 合计）。
 */
export async function recordInventoryTransaction(
  tx: Tx,
  organizationId: string,
  input: RecordInventoryTxnInput,
): Promise<RecordedInventoryTxn> {
  if (input.quantityScaled < 0n) {
    throw new MoneyError('Quantity cannot be negative.');
  }
  if (input.unitCostMinor < 0n) {
    throw new MoneyError('Unit cost cannot be negative.');
  }

  // 先读物料、并上行锁。
  //
  // 加权平均是一个「读当前值 -> 算 -> 写回」的序列，而 READ COMMITTED 下两笔
  // 同时入库会各自读到同一个旧平均成本，各自算出一个只考虑了自己那一笔的新
  // 平均成本，后提交的那个覆盖先提交的那个——先入的那批货的成本凭空消失，
  // 数量却两笔都加上了。这与 loadDepreciationPosting 里那把行锁防的是同一件事。
  const [item] = await tx`
    select id, name_en, current_quantity, current_avg_cost_minor, cost_method,
           inventory_account_id, cogs_account_id
    from inventory_items
    where id = ${input.inventoryItemId} and organization_id = ${organizationId}
    for update
  `;
  if (!item) throw new Error('Inventory item not found.');

  const oldQty = parseQuantityToScaled(item.current_quantity as string);
  const oldAvgCost = BigInt(item.current_avg_cost_minor as string);
  const oldValue = extendQuantity(oldAvgCost, oldQty);

  const q = input.quantityScaled;
  let newQty: bigint;
  let newAvgCost: bigint;
  /** 这一行流水上要记的单价：入库是进价，出库是结转时的平均成本。 */
  let effectiveUnitCost: bigint;

  if (input.type === 'purchase' || input.type === 'return') {
    newQty = oldQty + q;
    effectiveUnitCost = input.unitCostMinor;

    // 加权平均：(旧库存价值 + 本次价值) / 新数量。分子两项都带着 10^4 的
    // 放大，分母也带着，约掉之后结果直接就是 minor units——不需要额外乘除，
    // 也就没有第二个舍入点。
    //
    // cost_method = 'fifo' 走的是同一支。0009 没有建任何分层表，FIFO 今天
    // 没有实现；原来的写法是 fifo 物料在第一次入库之后平均成本**再也不变**，
    // 于是进价一涨，估值就越错越多，而那不是 FIFO，只是「永远用第一批的价」。
    // 在分层做出来之前，用一个定义明确的加权平均，好过用一个没有名字的错数。
    newAvgCost = newQty > 0n
      ? roundedDiv(oldAvgCost * oldQty + input.unitCostMinor * q, newQty)
      : input.unitCostMinor;
  } else if (input.type === 'sale') {
    newQty = oldQty - q;
    newAvgCost = oldAvgCost;
    effectiveUnitCost = oldAvgCost;
  } else {
    // adjustment：把数量直接设成盘点值。
    newQty = q;
    newAvgCost = newQty === 0n ? 0n : input.unitCostMinor;
    effectiveUnitCost = newAvgCost;
  }

  const newValue = extendQuantity(newAvgCost, newQty);

  const txnResult = await tx`
    insert into inventory_transactions (
      organization_id, inventory_item_id, type, quantity,
      unit_cost_minor, total_cost_minor, reference_type, reference_id,
      notes, created_by
    )
    values (
      ${organizationId}, ${input.inventoryItemId}, ${input.type},
      ${formatScaledQuantity(q)}::numeric, ${effectiveUnitCost.toString()},
      ${extendQuantity(effectiveUnitCost, q).toString()},
      ${input.referenceType ?? null}, ${input.referenceId ?? null},
      ${input.notes ?? null}, ${input.createdBy}
    )
    returning id
  `;

  await tx`
    update inventory_items
    set current_quantity = ${formatScaledQuantity(newQty)}::numeric,
        current_avg_cost_minor = ${newAvgCost.toString()}
    where id = ${input.inventoryItemId} and organization_id = ${organizationId}
  `;

  return {
    id: txnResult[0].id as string,
    newQuantityScaled: newQty,
    newAvgCostMinor: newAvgCost,
    // 进总账的是**存货价值的变化量**，不是这一行流水的合计。
    //
    // 两者在入库时几乎相等，在盘点调整时完全不等（调整既可能改数量也可能改
    // 单价），而按变化量记账能让一条不变量恒成立：存货科目的余额 = Σ(在库
    // 数量 × 平均成本)。用流水合计记账则每一次加权平均产生的舍入残差都会
    // 留在科目余额里，累积成一个越来越大、谁也解释不了的差额。
    valueDeltaMinor: newValue - oldValue,
    inventoryAccountId: (item.inventory_account_id as string | null) ?? null,
    cogsAccountId: (item.cogs_account_id as string | null) ?? null,
    itemName: item.name_en as string,
  };
}

export type InventoryValuationRow = {
  itemId: string;
  sku: string;
  nameEn: string;
  nameZh: string;
  unit: string;
  /** 放大 10^4 的在库数量。精确值，用它做算术。 */
  quantityScaled: bigint;
  /** 同一个数量的十进制字符串，四位小数，直接可显示。 */
  quantity: string;
  avgCostMinor: bigint;
  totalValueMinor: bigint;
};

/**
 * 存货估值：每个在用物料的在库数量 × 加权平均成本。
 *
 * 原来这里是 `avgCost * BigInt(Math.round(qty))`——先把小数数量四舍五入再乘，
 * 0.5 kg 的在库按 1 kg 估值；而且乘完之后没有除掉数量的放大倍数（旧代码里
 * qty 是 Number，所以没有放大倍数可除，但也因此只有整数数量才碰巧对）。
 * 改成定标整数相乘再一次性舍入。
 *
 * 这个函数今天没有调用方（inventory 设置页只调 listInventoryItems）。留着并
 * 修对，是因为它正是「库存进总账」之后用来跟存货科目余额对账的那张表——
 * 一个算错的对账口径比没有对账更糟。
 */
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
    const quantityScaled = parseQuantityToScaled(row.current_quantity as string);
    const avgCost = BigInt(row.current_avg_cost_minor as string);

    return {
      itemId: row.id as string,
      sku: row.sku as string,
      nameEn: row.name_en as string,
      nameZh: row.name_zh as string,
      unit: row.unit as string,
      quantityScaled,
      quantity: formatScaledQuantity(quantityScaled),
      avgCostMinor: avgCost,
      totalValueMinor: extendQuantity(avgCost, quantityScaled),
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

/**
 * currentQuantity / reorderLevel 在这个类型里仍然是 number，是**显示字段**。
 *
 * 没有改成 bigint 或字符串，是因为 components/settings/inventory-list.tsx
 * 直接用 InventoryItemRow 作 props 并在本地构造这个形状的对象字面量；
 * 加一个必填字段或换一个字段的类型，都会让那个不在本次范围内的文件编译不过。
 *
 * 真正要紧的是：本文件里**没有任何算术**读这两个字段。数量的精确值从库里
 * 的 numeric 文本经 parseQuantityToScaled 取（见 recordInventoryTransaction
 * 与 getInventoryValuation），Number() 只出现在这一处、只为显示。
 * 界面侧 `item.currentAvgCostMinor * BigInt(Math.round(item.currentQuantity))`
 * 那一句仍然是错的，已在交付报告中列给前端。
 */
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
