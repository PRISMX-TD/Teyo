import type { Tx } from '@/server/db/transaction';
// 数量的定标整数格式化与库存共用一份实现，理由见 server/actions/purchase_orders.ts
// 顶部那条 import 上的注释。
import { formatScaledQuantity, parseQuantityToScaled } from '@/server/repositories/inventory';

export type PurchaseOrderRow = {
  id: string;
  organizationId: string;
  contactId: string;
  contactName: string | null;
  poNumber: string;
  status: 'draft' | 'sent' | 'received' | 'billed' | 'closed' | 'voided';
  issueDate: string;
  expectedDate: string | null;
  currency: string;
  exchangeRate: bigint;
  baseTotalMinor: bigint;
  notes: string | null;
  voidedAt: string | null;
  createdAt: string;
  createdBy: string;
};

export type PoItemRow = {
  id: string;
  poId: string;
  description: string;
  /**
   * 放大 10^4 的数量——精确值，任何算术都用它。
   *
   * 原来这里是 `quantity: number`，由 `Number(row.quantity)` 得来。
   * numeric(12,4) 的值经过 double 之后，2.5 与 0.1 这类数再乘回单价就不再
   * 精确，而采购单的金额正是「数量 × 单价」。这个类型今天只有仓储自己用，
   * 换成 bigint 不影响任何界面。
   */
  quantityScaled: bigint;
  unitPriceMinor: bigint;
  amountMinor: bigint;
  taxRateId: string | null;
};

export type PurchaseOrderWithItems = PurchaseOrderRow & {
  items: PoItemRow[];
};

export async function listPurchaseOrders(
  tx: Tx,
  organizationId: string,
): Promise<PurchaseOrderRow[]> {
  const rows = await tx`
    select po.id, po.organization_id, po.contact_id, po.po_number,
           po.status, po.issue_date, po.expected_date, po.currency,
           po.exchange_rate, po.base_total_minor, po.notes,
           po.voided_at, po.created_at, po.created_by,
           c.name as contact_name
    from purchase_orders po
    left join contacts c on c.id = po.contact_id
    where po.organization_id = ${organizationId}
    order by po.created_at desc
  `;
  return rows.map(mapPo);
}

export async function getPurchaseOrder(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<PurchaseOrderWithItems | null> {
  const rows = await tx`
    select po.id, po.organization_id, po.contact_id, po.po_number,
           po.status, po.issue_date, po.expected_date, po.currency,
           po.exchange_rate, po.base_total_minor, po.notes,
           po.voided_at, po.created_at, po.created_by,
           c.name as contact_name
    from purchase_orders po
    left join contacts c on c.id = po.contact_id
    where po.id = ${id} and po.organization_id = ${organizationId}
  `;

  if (!rows.length) return null;

  const po = mapPo(rows[0]);

  const items = await tx`
    select id, po_id, description, quantity, unit_price_minor,
           amount_minor, tax_rate_id
    from po_items
    where po_id = ${id}
    order by id
  `;

  return {
    ...po,
    items: items.map(mapPoItem),
  };
}

export async function insertPurchaseOrder(
  tx: Tx,
  row: {
    organizationId: string;
    contactId: string;
    poNumber: string;
    issueDate: string;
    expectedDate?: string;
    currency: string;
    exchangeRate: bigint;
    baseTotalMinor: bigint;
    notes?: string;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const r = await tx`
    insert into purchase_orders (
      organization_id, contact_id, po_number, issue_date, expected_date,
      currency, exchange_rate, base_total_minor, notes, created_by
    )
    values (
      ${row.organizationId}, ${row.contactId}, ${row.poNumber},
      ${row.issueDate}, ${row.expectedDate ?? null},
      ${row.currency}, ${row.exchangeRate.toString()},
      ${row.baseTotalMinor.toString()}, ${row.notes ?? null}, ${row.createdBy}
    )
    returning id
  `;
  return { id: r[0].id as string };
}

export async function insertPoItems(
  tx: Tx,
  items: {
    poId: string;
    description: string;
    /** 放大 10^4 的数量。po_items.quantity 是 numeric(12,4)，见 0009 迁移。 */
    quantityScaled: bigint;
    unitPriceMinor: bigint;
    amountMinor: bigint;
    taxRateId?: string;
  }[],
): Promise<void> {
  if (items.length === 0) return;

  await tx`
    insert into po_items ${tx(
      items.map((item) => ({
        po_id: item.poId,
        description: item.description,
        // 数量以十进制字符串写入，不经 double。调用方传的是定标整数，
        // 这里只负责把它还原成 numeric(12,4) 认得的写法。
        quantity: formatScaledQuantity(item.quantityScaled),
        unit_price_minor: item.unitPriceMinor.toString(),
        amount_minor: item.amountMinor.toString(),
        tax_rate_id: item.taxRateId ?? null,
      })),
      'po_id',
      'description',
      'quantity',
      'unit_price_minor',
      'amount_minor',
      'tax_rate_id',
    )}
  `;
}

/**
 * 改采购单表头。
 *
 * exchange_rate 与 base_total_minor 原来写的是
 * `= ${fields.x?.toString() ?? null}::bigint`——没有 coalesce。两列都是
 * `not null`（0009），所以任何一次「只改备注」的保存都会试图把它们写成
 * NULL，直接撞 not-null 违反，用户看到的是一句裸的 Postgres 报错。
 * 这个 action 今天没有界面入口，所以这条路径从来没被走过；接上界面的那一天
 * 它会立刻炸。改成 coalesce，与同一句里其余几列一致。
 *
 * expected_date 与 notes 保持「传 undefined 就清空」的语义不变：它们可空，
 * 而「把预计到货日清掉」是一个用户真的会做的动作，没有别的表达方式。
 */
export async function updatePurchaseOrder(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: Partial<{
    contactId: string;
    issueDate: string;
    expectedDate: string;
    currency: string;
    exchangeRate: bigint;
    baseTotalMinor: bigint;
    notes: string;
  }>,
): Promise<void> {
  await tx`
    update purchase_orders set
      contact_id = coalesce(${fields.contactId ?? null}::uuid, contact_id),
      issue_date = coalesce(${fields.issueDate ?? null}::date, issue_date),
      expected_date = ${fields.expectedDate ?? null}::date,
      currency = coalesce(${fields.currency ?? null}, currency),
      exchange_rate = coalesce(${fields.exchangeRate?.toString() ?? null}::bigint, exchange_rate),
      base_total_minor = coalesce(${fields.baseTotalMinor?.toString() ?? null}::bigint, base_total_minor),
      notes = ${fields.notes ?? null}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function deletePoItems(tx: Tx, poId: string): Promise<void> {
  await tx`
    delete from po_items where po_id = ${poId}
  `;
}

/**
 * 改状态。作废时同时写 voided_at，撤销作废时清掉它。
 *
 * 原来只改 status。于是「这张单作废了没有」在库里有两个互不相干的记号：
 * status = 'voided' 与 voided_at is not null，而后者从来没有任何代码写过。
 * listPurchaseOrders 把 voided_at 读出来给界面用、0021 之后的报表也都按
 * voided_at 排除作废单据——一个永远为 null 的列，意味着作废的采购单在每一张
 * 报表里都还在。两个记号必须同进同出。
 */
export async function setPoStatus(
  tx: Tx,
  organizationId: string,
  id: string,
  status: 'draft' | 'sent' | 'received' | 'billed' | 'closed' | 'voided',
): Promise<void> {
  await tx`
    update purchase_orders
    set status = ${status}::po_status,
        voided_at = case when ${status} = 'voided' then coalesce(voided_at, now()) else null end
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/**
 * 下一个采购单编号，格式 PO-00001。
 *
 * 原来这个函数**永远返回 PO-00001**，第二张采购单必定撞 po_org_number
 * 唯一约束，用户看到一句裸的 Postgres 报错。两个原因叠在一起：
 *
 * 1. 正则写在 JS 模板字符串里：`` tx`... ~ '^PO-\d+$'` ``。模板字符串里的
 *    `\d` 不是正则的 `\d`，而是一个未被识别的转义序列，JS 把它求值成字母
 *    `d`——发到 Postgres 的模式是 `'^PO-d+$'`，匹配 'PO-ddd' 这种东西，
 *    永远匹配不到 'PO-00001'。查询因此恒返回零行，走进 `if (!rows.length)`
 *    那一支。改用 `[0-9]`，从根上不依赖反斜杠能不能活着穿过模板字符串。
 * 2. `order by po_number desc` 是按字符串排的。就算模式修对了，编号涨到
 *    六位时 'PO-100000' 在字典序里排在 'PO-99999' 前面，取到的「最大」是
 *    第 99999 号，下一个又回到 100000——从此每次都撞唯一约束。改成先转成
 *    整数再取 max。
 *
 * 并发仍然有一个窗口：两个人同时建单会读到同一个最大值。那一次由唯一约束
 * 兜住（报错而不是重号），修干净需要一条迁移给每家公司一个序列号表。已在
 * 交付报告中列出。
 */
export async function getNextPoNumber(tx: Tx, organizationId: string): Promise<string> {
  const rows = await tx`
    select coalesce(max(substring(po_number from 4)::bigint), 0) as last_number
    from purchase_orders
    where organization_id = ${organizationId}
      and po_number ~ '^PO-[0-9]+$'
  `;

  const next = BigInt(rows[0].last_number as string) + 1n;
  return `PO-${next.toString().padStart(5, '0')}`;
}

function mapPo(row: Record<string, unknown>): PurchaseOrderRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    contactId: row.contact_id as string,
    contactName: (row.contact_name as string | null) ?? null,
    poNumber: row.po_number as string,
    status: row.status as PurchaseOrderRow['status'],
    issueDate: row.issue_date as string,
    expectedDate: (row.expected_date as string | null) ?? null,
    currency: row.currency as string,
    exchangeRate: BigInt(row.exchange_rate as string),
    baseTotalMinor: BigInt(row.base_total_minor as string),
    notes: (row.notes as string | null) ?? null,
    voidedAt: row.voided_at ? (row.voided_at as string) : null,
    createdAt: (row.created_at as string),
    createdBy: row.created_by as string,
  };
}

function mapPoItem(row: Record<string, unknown>): PoItemRow {
  return {
    id: row.id as string,
    poId: row.po_id as string,
    description: row.description as string,
    quantityScaled: parseQuantityToScaled(row.quantity as string),
    unitPriceMinor: BigInt(row.unit_price_minor as string),
    amountMinor: BigInt(row.amount_minor as string),
    taxRateId: (row.tax_rate_id as string | null) ?? null,
  };
}
