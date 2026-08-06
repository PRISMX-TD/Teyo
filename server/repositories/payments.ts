import type { Tx } from '@/server/db/transaction';

export type PaymentRow = {
  id: string;
  organizationId: string;
  contactId: string;
  type: 'received' | 'made';
  amountMinor: bigint;
  currency: string;
  exchangeRate: bigint;
  baseAmountMinor: bigint;
  paymentDate: string;
  method: string;
  reference: string | null;
  notes: string | null;
  transactionId: string | null;
  voidedAt: string | null;
  createdAt: string;
  createdBy: string;
  contactName?: string;
};

export type PaymentItem = {
  id: string;
  paymentId: string;
  invoiceId: string | null;
  billId: string | null;
  amountMinor: bigint;
};

export type PaymentDetail = PaymentRow & {
  items: PaymentItem[];
};

export type NewPaymentRow = {
  organizationId: string;
  contactId: string;
  type: 'received' | 'made';
  amountMinor: bigint;
  currency: string;
  exchangeRate: bigint;
  baseAmountMinor: bigint;
  paymentDate: string;
  method: string;
  reference: string | null;
  notes: string | null;
  transactionId: string | null;
  createdBy: string;
};

export type NewPaymentItem = {
  paymentId: string;
  invoiceId: string | null;
  billId: string | null;
  amountMinor: bigint;
};

function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapRow(row: Record<string, unknown>): PaymentRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    contactId: row.contact_id as string,
    type: row.type as 'received' | 'made',
    amountMinor: BigInt(row.amount_minor as string),
    currency: row.currency as string,
    exchangeRate: BigInt(row.exchange_rate as string),
    baseAmountMinor: BigInt(row.base_amount_minor as string),
    paymentDate: formatDateOnly(row.payment_date as Date | string),
    method: row.method as string,
    reference: (row.reference as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    transactionId: (row.transaction_id as string | null) ?? null,
    voidedAt: row.voided_at ? (row.voided_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    createdBy: row.created_by as string,
    contactName: (row.contact_name as string | undefined),
  };
}

export async function listPayments(
  tx: Tx,
  organizationId: string,
  filters?: {
    contactId?: string;
    type?: 'received' | 'made';
    from?: string;
    to?: string;
  },
): Promise<PaymentRow[]> {
  const f = filters ?? {};

  const rows = await tx`
    select
      p.id, p.organization_id, p.contact_id, p.type,
      p.amount_minor, p.currency, p.exchange_rate,
      p.base_amount_minor, p.payment_date, p.method,
      p.reference, p.notes, p.transaction_id,
      p.voided_at, p.created_at, p.created_by,
      c.name as contact_name
    from payments p
    join contacts c on c.id = p.contact_id
    where p.organization_id = ${organizationId}
      and (${f.contactId ?? null}::uuid is null or p.contact_id = ${f.contactId ?? null}::uuid)
      and (${f.type ?? null}::payment_type is null or p.type = ${f.type ?? null}::payment_type)
      and (${f.from ?? null}::date is null or p.payment_date >= ${f.from ?? null}::date)
      and (${f.to ?? null}::date is null or p.payment_date <= ${f.to ?? null}::date)
    order by p.payment_date desc, p.created_at desc, p.id desc
  `;

  return rows.map(mapRow);
}

export async function getPayment(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<PaymentDetail | null> {
  const rows = await tx`
    select
      p.id, p.organization_id, p.contact_id, p.type,
      p.amount_minor, p.currency, p.exchange_rate,
      p.base_amount_minor, p.payment_date, p.method,
      p.reference, p.notes, p.transaction_id,
      p.voided_at, p.created_at, p.created_by,
      c.name as contact_name
    from payments p
    join contacts c on c.id = p.contact_id
    where p.id = ${id} and p.organization_id = ${organizationId}
  `;

  const row = rows.at(0);
  if (!row) return null;

  const items = await tx`
    select id, payment_id, invoice_id, bill_id, amount_minor
    from payment_items
    where payment_id = ${id}
    order by id
  `;

  return {
    ...mapRow(row),
    items: items.map((item) => ({
      id: item.id as string,
      paymentId: item.payment_id as string,
      invoiceId: (item.invoice_id as string | null) ?? null,
      billId: (item.bill_id as string | null) ?? null,
      amountMinor: BigInt(item.amount_minor as string),
    })),
  };
}

export async function insertPayment(
  tx: Tx,
  row: NewPaymentRow,
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into payments (
      organization_id, contact_id, type,
      amount_minor, currency, exchange_rate,
      base_amount_minor, payment_date, method,
      reference, notes, transaction_id, created_by
    )
    values (
      ${row.organizationId},
      ${row.contactId},
      ${row.type},
      ${row.amountMinor.toString()},
      ${row.currency},
      ${row.exchangeRate.toString()},
      ${row.baseAmountMinor.toString()},
      ${row.paymentDate},
      ${row.method},
      ${row.reference},
      ${row.notes},
      ${row.transactionId},
      ${row.createdBy}
    )
    returning id
  `;
  return { id: inserted[0].id as string };
}

export async function insertPaymentItems(
  tx: Tx,
  items: NewPaymentItem[],
): Promise<void> {
  if (items.length === 0) return;

  await tx`
    insert into payment_items ${tx(
      items.map((item) => ({
        payment_id: item.paymentId,
        invoice_id: item.invoiceId,
        bill_id: item.billId,
        amount_minor: item.amountMinor.toString(),
      })),
      'payment_id',
      'invoice_id',
      'bill_id',
      'amount_minor',
    )}
  `;
}

export async function voidPayment(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    update payments
    set voided_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}