import { NextResponse } from 'next/server';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getInvoicePdfData } from '@/server/repositories/invoice_pdf';

function esc(s: string | null): string {
  if (!s) return '';
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '')
    .replace(/\n/g, ' ');
}

function fmtMinor(minor: bigint): string {
  const s = minor.toString();
  const abs = s.startsWith('-') ? s.slice(1) : s;
  if (abs.length <= 2) {
    return `${s.startsWith('-') ? '-' : ''}0.${abs.padStart(2, '0')}`;
  }
  const intPart = abs.slice(0, -2);
  const fracPart = abs.slice(-2);
  return `${s.startsWith('-') ? '-' : ''}${intPart}.${fracPart}`;
}

function buildPdf(data: {
  organization: { name: string; address: string | null };
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
}): Buffer {
  const lines: string[] = [];
  const x = 50;
  let y = 750;

  function addLine(text: string, fontSize: number, newY: number) {
    lines.push(`BT /F1 ${fontSize} Tf ${x} ${newY} Td (${esc(text)}) Tj ET`);
    return newY - fontSize - 4;
  }

  // Header
  y = addLine(`INVOICE`, 20, y);
  y = addLine(`${data.organization.name}`, 14, y);
  if (data.organization.address) {
    y = addLine(`${data.organization.address}`, 10, y);
  }
  y -= 10;

  // Invoice info
  y = addLine(`Invoice #: ${data.invoice.invoiceNumber}`, 12, y);
  y = addLine(`Issue Date: ${data.invoice.issueDate}`, 10, y);
  y = addLine(`Due Date: ${data.invoice.dueDate}`, 10, y);
  y = addLine(`Status: ${data.invoice.status}`, 10, y);
  y -= 5;

  // Bill To
  y = addLine(`Bill To:`, 12, y);
  y = addLine(`  ${data.contact.name}`, 10, y);
  if (data.contact.email) y = addLine(`  ${data.contact.email}`, 10, y);
  if (data.contact.address) y = addLine(`  ${data.contact.address}`, 10, y);
  if (data.contact.taxId) y = addLine(`  Tax ID: ${data.contact.taxId}`, 10, y);
  y -= 10;

  // Items header
  const colX = [x, x + 200, x + 280, x + 360, x + 420];
  lines.push(`BT /F1 10 Tf ${colX[0]} ${y} Td (Description) Tj ET`);
  lines.push(`BT /F1 10 Tf ${colX[1]} ${y} Td (Qty) Tj ET`);
  lines.push(`BT /F1 10 Tf ${colX[2]} ${y} Td (Unit Price) Tj ET`);
  lines.push(`BT /F1 10 Tf ${colX[3]} ${y} Td (Amount) Tj ET`);
  y -= 14;
  // Divider line
  lines.push(`${colX[0]} ${y + 6} m ${colX[4] + 80} ${y + 6} l S`);
  y -= 4;

  for (const item of data.items) {
    y = addLine(`${item.description}`, 10, y);
    lines.push(`BT /F1 10 Tf ${colX[1]} ${y + 10} Td (${esc(item.quantity)}) Tj ET`);
    lines.push(`BT /F1 10 Tf ${colX[2]} ${y + 10} Td (${esc(fmtMinor(item.unitPriceMinor))}) Tj ET`);
    lines.push(`BT /F1 10 Tf ${colX[3]} ${y + 10} Td (${esc(fmtMinor(item.amountMinor))}) Tj ET`);
    y -= 14;
  }
  y -= 5;

  // Divider
  lines.push(`${colX[0]} ${y + 6} m ${colX[4] + 80} ${y + 6} l S`);
  y -= 8;

  // Totals
  y = addLine(`Subtotal: ${data.invoice.currency} ${fmtMinor(data.invoice.subTotalMinor)}`, 10, y);
  if (data.invoice.taxRateBps > 0) {
    y = addLine(`Tax (${(data.invoice.taxRateBps / 100).toFixed(1)}%): ${data.invoice.currency} ${fmtMinor(data.invoice.taxMinor)}`, 10, y);
  }
  y = addLine(`Total: ${data.invoice.currency} ${fmtMinor(data.invoice.totalMinor)}`, 12, y);
  y -= 10;

  if (data.invoice.notes) {
    y = addLine(`Notes: ${data.invoice.notes}`, 10, y);
  }

  const content = lines.join('\n');
  const contentObj = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

  const fontObj = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const pageObj = `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  const pagesObj = '<< /Type /Pages /Kids [4 0 R] /Count 1 >>';
  const catalogObj = '<< /Type /Catalog /Pages 3 0 R >>';

  const objects = [catalogObj, pagesObj, pageObj, contentObj, fontObj];
  const offsets: number[] = [];

  let buf = '%PDF-1.4\n';
  // Ensure binary comment for PDF validity
  buf += '%\xFF\xFE\xFD\xFC\n';

  for (const obj of objects) {
    offsets.push(Buffer.byteLength(buf));
    buf += `${offsets.length} 0 obj\n${obj}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(buf);
  buf += 'xref\n';
  buf += `0 ${objects.length + 1}\n`;
  buf += '0000000000 65535 f \n';
  for (const off of offsets) {
    buf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  buf += 'trailer\n';
  buf += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  buf += 'startxref\n';
  buf += `${xrefOffset}\n`;
  buf += '%%EOF\n';

  return Buffer.from(buf, 'latin1');
}

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const url = new URL(_request.url);
  const orgSlug = url.searchParams.get('orgSlug');

  if (!orgSlug) {
    return NextResponse.json({ error: 'orgSlug is required' }, { status: 400 });
  }

  const context = await requirePermission(orgSlug, 'transaction:read');

  const pdfData = await withTransaction(context.userId, (tx) =>
    getInvoicePdfData(tx, context.organizationId, id),
  );

  if (!pdfData) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  const pdf = buildPdf(pdfData);

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="invoice-${pdfData.invoice.invoiceNumber}.pdf"`,
    },
  });
}
