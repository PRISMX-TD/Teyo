import type { Tx } from '@/server/db/transaction';

export type BillStatus = 'draft' | 'received' | 'paid' | 'overdue' | 'voided';

export type BillListRow = {
  id: string;
  billNumber: string | null;
  status: BillStatus;
  issueDate: string;
  dueDate: string;
  currency: string;
  totalMinor: bigint;
  notes: string | null;
  contactId: string;
  contactName: string;
  transactionId: string | null;
  voidedAt: string | null;
  createdAt: string;
};

export type BillDetail = BillListRow & {
  items: BillItemRow[];
};

export type BillItemRow = {
  id: string;
  billId: string;
  description: string;
  amountMinor: bigint;
};

export type NewBillRow = {
  organizationId: string;
  contactId: string;
  billNumber: string;
  status: BillStatus;
  issueDate: string;
  dueDate: string;
  currency: string;
  totalMinor: bigint;
  notes: string | null;
};

export type NewBillItemRow = {
  billId: string;
  description: string;
  amountMinor: bigint;
};

export type BillUpdate = {
  contactId?: string;
  issueDate?: string;
  dueDate?: string;
  currency?: string;
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

function mapListRow(row: Record<string, unknown>): BillListRow {
  return {
    id: row.id as string,
    billNumber: (row.bill_number as string | null) ?? null,
    status: row.status as BillStatus,
    issueDate: formatDateOnly(row.issue_date as Date | string),
    dueDate: formatDateOnly(row.due_date as Date | string),
    currency: row.currency as string,
    totalMinor: BigInt(row.total_minor as string),
    notes: (row.notes as string | null) ?? null,
    contactId: row.contact_id as string,
    contactName: row.contact_name as string,
    transactionId: (row.transaction_id as string | null) ?? null,
    voidedAt: row.voided_at ? (row.voided_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function listBills(
  tx: Tx,
  organizationId: string,
): Promise<BillListRow[]> {
  const rows = await tx`
    select
      b.id, b.bill_number, b.status, b.issue_date, b.due_date,
      b.currency, b.total_minor, b.notes, b.contact_id,
      b.transaction_id, b.voided_at, b.created_at,
      c.name as contact_name
    from bills b
    join contacts c on c.id = b.contact_id
    where b.organization_id = ${organizationId}
    order by b.created_at desc
  `;

  return rows.map(mapListRow);
}

export async function getBill(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<BillDetail | null> {
  const rows = await tx`
    select
      b.id, b.bill_number, b.status, b.issue_date, b.due_date,
      b.currency, b.total_minor, b.notes, b.contact_id,
      b.transaction_id, b.voided_at, b.created_at,
      c.name as contact_name
    from bills b
    join contacts c on c.id = b.contact_id
    where b.id = ${id} and b.organization_id = ${organizationId}
  `;

  const row = rows.at(0);
  if (!row) return null;

  const items = await tx`
    select id, bill_id, description, amount_minor
    from bill_items
    where bill_id = ${id}
    order by id
  `;

  return {
    ...mapListRow(row),
    items: items.map((item) => ({
      id: item.id as string,
      billId: item.bill_id as string,
      description: item.description as string,
      amountMinor: BigInt(item.amount_minor as string),
    })),
  };
}

export async function insertBill(
  tx: Tx,
  row: NewBillRow,
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into bills (
      organization_id, contact_id, bill_number, status,
      issue_date, due_date, currency, total_minor, notes
    )
    values (
      ${row.organizationId},
      ${row.contactId},
      ${row.billNumber},
      ${row.status},
      ${row.issueDate},
      ${row.dueDate},
      ${row.currency},
      ${row.totalMinor.toString()},
      ${row.notes}
    )
    returning id
  `;
  return { id: inserted[0].id as string };
}

export async function insertBillItems(
  tx: Tx,
  items: NewBillItemRow[],
): Promise<void> {
  if (items.length === 0) return;

  await tx`
    insert into bill_items ${tx(
      items.map((item) => ({
        bill_id: item.billId,
        description: item.description,
        amount_minor: item.amountMinor.toString(),
      })),
      'bill_id',
      'description',
      'amount_minor',
    )}
  `;
}

export async function updateBill(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: BillUpdate,
): Promise<void> {
  const sets: Record<string, unknown> = {};
  if (fields.contactId !== undefined) sets.contact_id = fields.contactId;
  if (fields.issueDate !== undefined) sets.issue_date = fields.issueDate;
  if (fields.dueDate !== undefined) sets.due_date = fields.dueDate;
  if (fields.currency !== undefined) sets.currency = fields.currency;
  if (fields.totalMinor !== undefined) sets.total_minor = fields.totalMinor.toString();
  if (fields.notes !== undefined) sets.notes = fields.notes;
  sets.updated_at = tx`now()`;

  const keys = Object.keys(sets);
  if (keys.length === 0) return;

  await tx`
    update bills set ${tx(sets as Record<string, never>)}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function deleteBillItems(
  tx: Tx,
  billId: string,
): Promise<void> {
  await tx`
    delete from bill_items
    where bill_id = ${billId}
  `;
}

export async function setBillStatus(
  tx: Tx,
  organizationId: string,
  id: string,
  status: BillStatus,
): Promise<void> {
  await tx`
    update bills
    set status = ${status}, updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function getNextBillNumber(
  tx: Tx,
  organizationId: string,
): Promise<string> {
  const rows = await tx`
    select bill_number
    from bills
    where organization_id = ${organizationId}
    order by created_at desc
    limit 1
  `;

  const last = rows.at(0);
  if (!last || !last.bill_number) return 'BILL-00001';

  const lastNumber = last.bill_number as string;
  const match = lastNumber.match(/^BILL-(\d+)$/);
  if (!match) return 'BILL-00001';

  const next = parseInt(match[1], 10) + 1;
  return `BILL-${String(next).padStart(5, '0')}`;
}
