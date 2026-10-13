import type { Tx } from '@/server/db/transaction';
import {
  isInvoiceLocale,
  isInvoiceSignoff,
  type InvoiceLocale,
  type InvoiceSignoff,
} from '@/lib/invoice-options';
import { sumDeductedByDocument } from '@/server/repositories/payments';

export type InvoicePdfData = {
  organization: {
    name: string;
    address: string | null;
    registrationNumber: string | null;
    taxNumber: string | null;
    phone: string | null;
    email: string | null;
    paymentDetails: string | null;
    /** branding bucket 里的对象路径，页面自己换签名 URL。 */
    logoPath: string | null;
    /** 发票的版式选项（0036），见 lib/invoice-options.ts。 */
    invoiceLocale: InvoiceLocale;
    invoiceSignoff: InvoiceSignoff;
    invoiceTaxLabel: string | null;
    invoiceFooter: string | null;
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
    reference: string | null;
    /**
     * 已经冲掉的金额（原币）：未作废的收款核销 + 已签发的贷项通知单。
     * 与收款页「还欠多少」同一个口径（sumDeductedByDocument）——发票上印的
     * 应付金额和收款页预填的数不能是两个数。
     */
    deductedMinor: bigint;
  };
  contact: {
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    taxId: string | null;
    /** 客户资料上的付款条件，比如「30 天」。 */
    paymentTerms: string | null;
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
      i.subtotal_minor, i.tax_rate_bps, i.tax_minor, i.total_minor, i.notes, i.reference,
      c.name as contact_name, c.email as contact_email, c.phone as contact_phone,
      c.address as contact_address, c.tax_id as contact_tax_id,
      c.payment_terms as contact_payment_terms
    from invoices i
    join contacts c on c.id = i.contact_id
    where i.id = ${invoiceId} and i.organization_id = ${organizationId}
  `;

  const invoiceRow = invoiceRows.at(0);
  if (!invoiceRow) return null;

  const orgRows = await tx`
    select name, address, registration_number, tax_number, phone, email,
           payment_details, logo_path,
           invoice_locale, invoice_signoff, invoice_tax_label, invoice_footer
    from organizations
    where id = ${organizationId}
  `;
  const orgRow = orgRows.at(0);
  if (!orgRow) return null;

  const itemRows = await tx`
    select description, quantity::text as quantity, unit_price_minor, amount_minor
    from invoice_items
    where invoice_id = ${invoiceId}
    order by position nulls last, id
  `;

  const deducted = await sumDeductedByDocument(tx, organizationId, 'invoice', [invoiceId]);

  return {
    organization: {
      name: orgRow.name as string,
      address: (orgRow.address as string | null) ?? null,
      registrationNumber: (orgRow.registration_number as string | null) ?? null,
      taxNumber: (orgRow.tax_number as string | null) ?? null,
      phone: (orgRow.phone as string | null) ?? null,
      email: (orgRow.email as string | null) ?? null,
      paymentDetails: (orgRow.payment_details as string | null) ?? null,
      logoPath: (orgRow.logo_path as string | null) ?? null,
      invoiceLocale: isInvoiceLocale(orgRow.invoice_locale) ? orgRow.invoice_locale : 'en',
      invoiceSignoff: isInvoiceSignoff(orgRow.invoice_signoff)
        ? orgRow.invoice_signoff
        : 'computer_generated',
      invoiceTaxLabel: (orgRow.invoice_tax_label as string | null) ?? null,
      invoiceFooter: (orgRow.invoice_footer as string | null) ?? null,
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
      reference: (invoiceRow.reference as string | null) ?? null,
      deductedMinor: deducted.get(invoiceId) ?? 0n,
    },
    contact: {
      name: invoiceRow.contact_name as string,
      email: (invoiceRow.contact_email as string | null) ?? null,
      phone: (invoiceRow.contact_phone as string | null) ?? null,
      address: (invoiceRow.contact_address as string | null) ?? null,
      taxId: (invoiceRow.contact_tax_id as string | null) ?? null,
      paymentTerms: (invoiceRow.contact_payment_terms as string | null) ?? null,
    },
    items: itemRows.map((item) => ({
      description: item.description as string,
      quantity: item.quantity as string,
      unitPriceMinor: BigInt(item.unit_price_minor as string),
      amountMinor: BigInt(item.amount_minor as string),
    })),
  };
}
