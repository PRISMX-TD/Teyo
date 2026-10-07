import type { Tx } from '@/server/db/transaction';

export type InvoicePdfData = {
  organization: {
    name: string;
    address: string | null;
  };
  invoice: {
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    status: string;
    currency: string;
    subTotalMinor: bigint;
    taxRateBps: number;
    taxMinor: bigint;
    totalMinor: bigint;
    notes: string | null;
  };
  contact: {
    name: string;
    email: string | null;
    address: string | null;
    taxId: string | null;
  };
  items: {
    description: string;
    quantity: string;
    unitPriceMinor: bigint;
    amountMinor: bigint;
  }[];
};

function fmtDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const d = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function getInvoicePdfData(
  tx: Tx,
  organizationId: string,
  invoiceId: string,
): Promise<InvoicePdfData | null> {
  const invoiceRows = await tx`
    select
      i.invoice_number, i.status, i.issue_date, i.due_date, i.currency,
      i.subtotal_minor, i.tax_rate_bps, i.tax_minor, i.total_minor, i.notes,
      c.name as contact_name, c.email as contact_email,
      c.address as contact_address, c.tax_id as contact_tax_id
    from invoices i
    join contacts c on c.id = i.contact_id
    where i.id = ${invoiceId} and i.organization_id = ${organizationId}
  `;

  const invoiceRow = invoiceRows.at(0);
  if (!invoiceRow) return null;

  const orgRows = await tx`
    select name, address from organizations
    where id = ${organizationId}
  `;
  const orgRow = orgRows.at(0);
  if (!orgRow) return null;

  const itemRows = await tx`
    select description, quantity::text as quantity, unit_price_minor, amount_minor
    from invoice_items
    where invoice_id = ${invoiceId}
    order by id
  `;

  return {
    organization: {
      name: orgRow.name as string,
      address: (orgRow.address as string | null) ?? null,
    },
    invoice: {
      invoiceNumber: invoiceRow.invoice_number as string,
      issueDate: fmtDate(invoiceRow.issue_date as Date | string),
      dueDate: fmtDate(invoiceRow.due_date as Date | string),
      status: invoiceRow.status as string,
      currency: invoiceRow.currency as string,
      subTotalMinor: BigInt(invoiceRow.subtotal_minor as string),
      taxRateBps: Number(invoiceRow.tax_rate_bps),
      taxMinor: BigInt(invoiceRow.tax_minor as string),
      totalMinor: BigInt(invoiceRow.total_minor as string),
      notes: (invoiceRow.notes as string | null) ?? null,
    },
    contact: {
      name: invoiceRow.contact_name as string,
      email: (invoiceRow.contact_email as string | null) ?? null,
      address: (invoiceRow.contact_address as string | null) ?? null,
      taxId: (invoiceRow.contact_tax_id as string | null) ?? null,
    },
    items: itemRows.map((item) => ({
      description: item.description as string,
      quantity: item.quantity as string,
      unitPriceMinor: BigInt(item.unit_price_minor as string),
      amountMinor: BigInt(item.amount_minor as string),
    })),
  };
}
