import type { Tx } from '@/server/db/transaction';

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
  quantity: number;
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
    quantity: number;
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
        quantity: item.quantity,
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
      exchange_rate = ${fields.exchangeRate?.toString() ?? null}::bigint,
      base_total_minor = ${fields.baseTotalMinor?.toString() ?? null}::bigint,
      notes = ${fields.notes ?? null}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function deletePoItems(tx: Tx, poId: string): Promise<void> {
  await tx`
    delete from po_items where po_id = ${poId}
  `;
}

export async function setPoStatus(
  tx: Tx,
  organizationId: string,
  id: string,
  status: 'draft' | 'sent' | 'received' | 'billed' | 'closed' | 'voided',
): Promise<void> {
  await tx`
    update purchase_orders
    set status = ${status}::po_status
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/**
 * 获取下一个 PO 编号，格式 PO-00001。
 * 从当前组织中已有的最大编号递增。
 */
export async function getNextPoNumber(tx: Tx, organizationId: string): Promise<string> {
  const rows = await tx`
    select po_number
    from purchase_orders
    where organization_id = ${organizationId}
      and po_number ~ '^PO-\d+$'
    order by po_number desc
    limit 1
  `;

  if (!rows.length) return 'PO-00001';

  const last = rows[0].po_number as string;
  const num = parseInt(last.replace('PO-', ''), 10);
  const next = (num + 1).toString().padStart(5, '0');
  return `PO-${next}`;
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
    quantity: Number(row.quantity),
    unitPriceMinor: BigInt(row.unit_price_minor as string),
    amountMinor: BigInt(row.amount_minor as string),
    taxRateId: (row.tax_rate_id as string | null) ?? null,
  };
}
