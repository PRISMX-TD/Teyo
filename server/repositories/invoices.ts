import type { Tx } from '@/server/db/transaction';

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'voided';

export type InvoiceListRow = {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  issueDate: string;
  dueDate: string;
  currency: string;
  subTotalMinor: bigint;
  taxRateBps: number;
  taxMinor: bigint;
  totalMinor: bigint;
  notes: string | null;
  contactId: string;
  contactName: string;
  transactionId: string | null;
  voidedAt: string | null;
  createdAt: string;
};

export type InvoiceDetail = InvoiceListRow & {
  items: InvoiceItemRow[];
};

export type InvoiceItemRow = {
  id: string;
  invoiceId: string;
  description: string;
  quantity: string;
  unitPriceMinor: bigint;
  amountMinor: bigint;
};

export type NewInvoiceRow = {
  organizationId: string;
  contactId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  issueDate: string;
  dueDate: string;
  currency: string;
  subTotalMinor: bigint;
  taxRateBps: number;
  taxMinor: bigint;
  totalMinor: bigint;
  notes: string | null;
};

export type NewInvoiceItemRow = {
  invoiceId: string;
  description: string;
  quantity: string;
  unitPriceMinor: bigint;
  amountMinor: bigint;
};

export type InvoiceUpdate = {
  contactId?: string;
  issueDate?: string;
  dueDate?: string;
  currency?: string;
  subTotalMinor?: bigint;
  taxRateBps?: number;
  taxMinor?: bigint;
  totalMinor?: bigint;
  notes?: string | null;
};

function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapListRow(row: Record<string, unknown>): InvoiceListRow {
  return {
    id: row.id as string,
    invoiceNumber: row.invoice_number as string,
    status: row.status as InvoiceStatus,
    issueDate: formatDateOnly(row.issue_date as Date | string),
    dueDate: formatDateOnly(row.due_date as Date | string),
    currency: row.currency as string,
    subTotalMinor: BigInt(row.subtotal_minor as string),
    taxRateBps: Number(row.tax_rate_bps),
    taxMinor: BigInt(row.tax_minor as string),
    totalMinor: BigInt(row.total_minor as string),
    notes: (row.notes as string | null) ?? null,
    contactId: row.contact_id as string,
    contactName: row.contact_name as string,
    transactionId: (row.transaction_id as string | null) ?? null,
    voidedAt: row.voided_at ? (row.voided_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function listInvoices(
  tx: Tx,
  organizationId: string,
): Promise<InvoiceListRow[]> {
  const rows = await tx`
    select
      i.id, i.invoice_number, i.status, i.issue_date, i.due_date,
      i.currency, i.subtotal_minor, i.tax_rate_bps, i.tax_minor,
      i.total_minor, i.notes, i.contact_id, i.transaction_id,
      i.voided_at, i.created_at,
      c.name as contact_name
    from invoices i
    join contacts c on c.id = i.contact_id
    where i.organization_id = ${organizationId}
    order by i.created_at desc
  `;

  return rows.map(mapListRow);
}

export async function getInvoice(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<InvoiceDetail | null> {
  const rows = await tx`
    select
      i.id, i.invoice_number, i.status, i.issue_date, i.due_date,
      i.currency, i.subtotal_minor, i.tax_rate_bps, i.tax_minor,
      i.total_minor, i.notes, i.contact_id, i.transaction_id,
      i.voided_at, i.created_at,
      c.name as contact_name
    from invoices i
    join contacts c on c.id = i.contact_id
    where i.id = ${id} and i.organization_id = ${organizationId}
  `;

  const row = rows.at(0);
  if (!row) return null;

  const items = await tx`
    select id, invoice_id, description, quantity::text as quantity, unit_price_minor, amount_minor
    from invoice_items
    where invoice_id = ${id}
    order by id
  `;

  return {
    ...mapListRow(row),
    items: items.map((item) => ({
      id: item.id as string,
      invoiceId: item.invoice_id as string,
      description: item.description as string,
      quantity: item.quantity as string,
      unitPriceMinor: BigInt(item.unit_price_minor as string),
      amountMinor: BigInt(item.amount_minor as string),
    })),
  };
}

export async function insertInvoice(
  tx: Tx,
  row: NewInvoiceRow,
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into invoices (
      organization_id, contact_id, invoice_number, status,
      issue_date, due_date, currency, subtotal_minor,
      tax_rate_bps, tax_minor, total_minor, notes
    )
    values (
      ${row.organizationId},
      ${row.contactId},
      ${row.invoiceNumber},
      ${row.status},
      ${row.issueDate},
      ${row.dueDate},
      ${row.currency},
      ${row.subTotalMinor.toString()},
      ${row.taxRateBps},
      ${row.taxMinor.toString()},
      ${row.totalMinor.toString()},
      ${row.notes}
    )
    returning id
  `;
  return { id: inserted[0].id as string };
}

export async function insertInvoiceItems(
  tx: Tx,
  items: NewInvoiceItemRow[],
): Promise<void> {
  if (items.length === 0) return;

  await tx`
    insert into invoice_items ${tx(
      items.map((item) => ({
        invoice_id: item.invoiceId,
        description: item.description,
        quantity: item.quantity,
        unit_price_minor: item.unitPriceMinor.toString(),
        amount_minor: item.amountMinor.toString(),
      })),
      'invoice_id',
      'description',
      'quantity',
      'unit_price_minor',
      'amount_minor',
    )}
  `;
}

export async function updateInvoice(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: InvoiceUpdate,
): Promise<void> {
  const sets: Record<string, unknown> = {};
  if (fields.contactId !== undefined) sets.contact_id = fields.contactId;
  if (fields.issueDate !== undefined) sets.issue_date = fields.issueDate;
  if (fields.dueDate !== undefined) sets.due_date = fields.dueDate;
  if (fields.currency !== undefined) sets.currency = fields.currency;
  if (fields.subTotalMinor !== undefined) sets.subtotal_minor = fields.subTotalMinor.toString();
  if (fields.taxRateBps !== undefined) sets.tax_rate_bps = fields.taxRateBps;
  if (fields.taxMinor !== undefined) sets.tax_minor = fields.taxMinor.toString();
  if (fields.totalMinor !== undefined) sets.total_minor = fields.totalMinor.toString();
  if (fields.notes !== undefined) sets.notes = fields.notes;
  sets.updated_at = tx`now()`;

  const keys = Object.keys(sets);
  if (keys.length === 0) return;

  await tx`
    update invoices set ${tx(sets as Record<string, never>)}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function deleteInvoiceItems(
  tx: Tx,
  invoiceId: string,
): Promise<void> {
  await tx`
    delete from invoice_items
    where invoice_id = ${invoiceId}
  `;
}

export async function setInvoiceStatus(
  tx: Tx,
  organizationId: string,
  id: string,
  status: InvoiceStatus,
): Promise<void> {
  await tx`
    update invoices
    set status = ${status}, updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function getNextInvoiceNumber(
  tx: Tx,
  organizationId: string,
): Promise<string> {
  const rows = await tx`
    select invoice_number
    from invoices
    where organization_id = ${organizationId}
    order by created_at desc
    limit 1
  `;

  const last = rows.at(0);
  if (!last) return 'INV-00001';

  const lastNumber = last.invoice_number as string;
  const match = lastNumber.match(/^INV-(\d+)$/);
  if (!match) return 'INV-00001';

  const next = parseInt(match[1], 10) + 1;
  return `INV-${String(next).padStart(5, '0')}`;
}
