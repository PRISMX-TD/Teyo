import type { Tx } from '@/server/db/transaction';

export type CreditNoteStatus = 'draft' | 'issued' | 'applied' | 'voided';

export type CreditNoteListRow = {
  id: string;
  invoiceId: string | null;
  contactId: string;
  contactName: string;
  cnNumber: string;
  status: CreditNoteStatus;
  issueDate: string;
  currency: string;
  exchangeRate: string;
  baseAmountMinor: bigint;
  reason: string | null;
  notes: string | null;
  voidedAt: string | null;
  createdAt: string;
  createdBy: string;
};

export type CreditNoteDetail = CreditNoteListRow & {
  items: CreditNoteItemRow[];
};

export type CreditNoteItemRow = {
  id: string;
  creditNoteId: string;
  description: string;
  quantity: string;
  unitPriceMinor: bigint;
  amountMinor: bigint;
  taxRateId: string | null;
};

export type NewCreditNoteRow = {
  organizationId: string;
  invoiceId: string | null;
  contactId: string;
  contactName: string | null;
  cnNumber: string;
  status: CreditNoteStatus;
  issueDate: string;
  currency: string;
  exchangeRate: bigint;
  baseAmountMinor: bigint;
  reason: string | null;
  notes: string | null;
  createdBy: string;
};

export type NewCreditNoteItemRow = {
  creditNoteId: string;
  description: string;
  quantity: string;
  unitPriceMinor: bigint;
  amountMinor: bigint;
  taxRateId: string | null;
};

export type CreditNoteUpdate = {
  invoiceId?: string | null;
  contactId?: string;
  contactName?: string | null;
  issueDate?: string;
  currency?: string;
  exchangeRate?: bigint;
  baseAmountMinor?: bigint;
  reason?: string | null;
  notes?: string | null;
};

function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapListRow(row: Record<string, unknown>): CreditNoteListRow {
  return {
    id: row.id as string,
    invoiceId: (row.invoice_id as string | null) ?? null,
    contactId: row.contact_id as string,
    contactName: row.contact_name as string,
    cnNumber: row.cn_number as string,
    status: row.status as CreditNoteStatus,
    issueDate: formatDateOnly(row.issue_date as Date | string),
    currency: row.currency as string,
    exchangeRate: String(row.exchange_rate),
    baseAmountMinor: BigInt(row.base_amount_minor as string),
    reason: (row.reason as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    voidedAt: row.voided_at ? (row.voided_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    createdBy: row.created_by as string,
  };
}

export async function listCreditNotes(
  tx: Tx,
  organizationId: string,
): Promise<CreditNoteListRow[]> {
  const rows = await tx`
    select
      cn.id, cn.invoice_id, cn.contact_id, cn.cn_number, cn.status,
      cn.issue_date, cn.currency, cn.exchange_rate, cn.base_amount_minor,
      cn.reason, cn.notes, cn.voided_at, cn.created_at, cn.created_by,
      c.name as contact_name
    from credit_notes cn
    join contacts c on c.id = cn.contact_id
    where cn.organization_id = ${organizationId}
    order by cn.created_at desc
  `;

  return rows.map(mapListRow);
}

export async function getCreditNote(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<CreditNoteDetail | null> {
  const rows = await tx`
    select
      cn.id, cn.invoice_id, cn.contact_id, cn.cn_number, cn.status,
      cn.issue_date, cn.currency, cn.exchange_rate, cn.base_amount_minor,
      cn.reason, cn.notes, cn.voided_at, cn.created_at, cn.created_by,
      c.name as contact_name
    from credit_notes cn
    join contacts c on c.id = cn.contact_id
    where cn.id = ${id} and cn.organization_id = ${organizationId}
  `;

  const row = rows.at(0);
  if (!row) return null;

  const items = await tx`
    select id, credit_note_id, description, quantity::text as quantity,
           unit_price_minor, amount_minor, tax_rate_id
    from credit_note_items
    where credit_note_id = ${id}
    order by id
  `;

  return {
    ...mapListRow(row),
    items: items.map((item) => ({
      id: item.id as string,
      creditNoteId: item.credit_note_id as string,
      description: item.description as string,
      quantity: item.quantity as string,
      unitPriceMinor: BigInt(item.unit_price_minor as string),
      amountMinor: BigInt(item.amount_minor as string),
      taxRateId: (item.tax_rate_id as string | null) ?? null,
    })),
  };
}

export async function insertCreditNote(
  tx: Tx,
  row: NewCreditNoteRow,
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into credit_notes (
      organization_id, invoice_id, contact_id, contact_name, cn_number, status,
      issue_date, currency, exchange_rate, base_amount_minor, reason, notes, created_by
    )
    values (
      ${row.organizationId},
      ${row.invoiceId},
      ${row.contactId},
      ${row.contactName},
      ${row.cnNumber},
      ${row.status},
      ${row.issueDate},
      ${row.currency},
      ${row.exchangeRate.toString()},
      ${row.baseAmountMinor.toString()},
      ${row.reason},
      ${row.notes},
      ${row.createdBy}
    )
    returning id
  `;
  return { id: inserted[0].id as string };
}

export async function insertCreditNoteItems(
  tx: Tx,
  items: NewCreditNoteItemRow[],
): Promise<void> {
  if (items.length === 0) return;

  await tx`
    insert into credit_note_items ${tx(
      items.map((item) => ({
        credit_note_id: item.creditNoteId,
        description: item.description,
        quantity: item.quantity,
        unit_price_minor: item.unitPriceMinor.toString(),
        amount_minor: item.amountMinor.toString(),
        tax_rate_id: item.taxRateId,
      })),
      'credit_note_id',
      'description',
      'quantity',
      'unit_price_minor',
      'amount_minor',
      'tax_rate_id',
    )}
  `;
}

export async function updateCreditNote(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: CreditNoteUpdate,
): Promise<void> {
  const sets: Record<string, unknown> = {};
  if (fields.invoiceId !== undefined) sets.invoice_id = fields.invoiceId;
  if (fields.contactId !== undefined) sets.contact_id = fields.contactId;
  if (fields.contactName !== undefined) sets.contact_name = fields.contactName;
  if (fields.issueDate !== undefined) sets.issue_date = fields.issueDate;
  if (fields.currency !== undefined) sets.currency = fields.currency;
  if (fields.exchangeRate !== undefined) sets.exchange_rate = fields.exchangeRate.toString();
  if (fields.baseAmountMinor !== undefined) sets.base_amount_minor = fields.baseAmountMinor.toString();
  if (fields.reason !== undefined) sets.reason = fields.reason;
  if (fields.notes !== undefined) sets.notes = fields.notes;

  const keys = Object.keys(sets);
  if (keys.length === 0) return;

  await tx`
    update credit_notes set ${tx(sets as Record<string, never>)}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function deleteCreditNoteItems(
  tx: Tx,
  creditNoteId: string,
): Promise<void> {
  await tx`
    delete from credit_note_items
    where credit_note_id = ${creditNoteId}
  `;
}

export async function setCreditNoteStatus(
  tx: Tx,
  organizationId: string,
  id: string,
  status: CreditNoteStatus,
): Promise<void> {
  const additions: Record<string, unknown> = { status };
  if (status === 'voided') {
    additions.voided_at = tx`now()`;
  }

  await tx`
    update credit_notes set ${tx(additions as Record<string, never>)}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function getNextCnNumber(
  tx: Tx,
  organizationId: string,
): Promise<string> {
  const rows = await tx`
    select cn_number
    from credit_notes
    where organization_id = ${organizationId}
    order by created_at desc
    limit 1
  `;

  const last = rows.at(0);
  if (!last) return 'CN-00001';

  const lastNumber = last.cn_number as string;
  const match = lastNumber.match(/^CN-(\d+)$/);
  if (!match) return 'CN-00001';

  const next = parseInt(match[1], 10) + 1;
  return `CN-${String(next).padStart(5, '0')}`;
}
