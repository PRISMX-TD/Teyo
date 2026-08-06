import type { Tx } from '@/server/db/transaction';

export type TaxRateRow = {
  id: string;
  organizationId: string;
  nameEn: string;
  nameZh: string;
  rateBps: number;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
};

export type TaxReportRow = {
  taxRateName: string | null;
  taxRate: number;
  netAmount: bigint;
  taxAmount: bigint;
};

function mapTaxRate(row: Record<string, unknown>): TaxRateRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    nameEn: row.name_en as string,
    nameZh: row.name_zh as string,
    rateBps: Number(row.rate_bps),
    isDefault: row.is_default as boolean,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function listTaxRates(
  tx: Tx,
  organizationId: string,
): Promise<TaxRateRow[]> {
  const rows = await tx`
    select id, organization_id, name_en, name_zh, rate_bps, is_default, is_active, created_at
    from tax_rates
    where organization_id = ${organizationId} and is_active = true
    order by is_default desc, name_en
  `;
  return rows.map(mapTaxRate);
}

export async function insertTaxRate(
  tx: Tx,
  row: {
    organizationId: string;
    nameEn: string;
    nameZh: string;
    rateBps: number;
    isDefault: boolean;
  },
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into tax_rates (organization_id, name_en, name_zh, rate_bps, is_default)
    values (${row.organizationId}, ${row.nameEn}, ${row.nameZh}, ${row.rateBps}, ${row.isDefault})
    returning id
  `;
  return { id: inserted[0].id as string };
}

export async function updateTaxRate(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: {
    nameEn?: string;
    nameZh?: string;
    rateBps?: number;
    isDefault?: boolean;
  },
): Promise<void> {
  const sets: Record<string, unknown> = {};
  if (fields.nameEn !== undefined) sets.name_en = fields.nameEn;
  if (fields.nameZh !== undefined) sets.name_zh = fields.nameZh;
  if (fields.rateBps !== undefined) sets.rate_bps = fields.rateBps;
  if (fields.isDefault !== undefined) sets.is_default = fields.isDefault;

  const keys = Object.keys(sets);
  if (keys.length === 0) return;

  await tx`
    update tax_rates set ${tx(sets as Record<string, never>)}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function setDefaultTaxRate(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    update tax_rates set is_default = false
    where organization_id = ${organizationId} and is_default = true
  `;
  await tx`
    update tax_rates set is_default = true
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function deleteTaxRate(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  const rateRows = await tx`
    select rate_bps from tax_rates
    where id = ${id} and organization_id = ${organizationId}
  `;
  if (rateRows.length === 0) return;

  const rateBps = Number(rateRows[0].rate_bps);

  const refs = await tx`
    select count(*)::int as cnt from invoices
    where organization_id = ${organizationId}
      and tax_rate_bps = ${rateBps}
      and voided_at is null
  `;
  if (Number(refs[0].cnt) > 0) {
    throw new Error('This tax rate is used by one or more invoices and cannot be deleted.');
  }

  await tx`
    update tax_rates set is_active = false
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function getTaxReport(
  tx: Tx,
  organizationId: string,
  from: string,
  to: string,
): Promise<{
  outputTax: TaxReportRow[];
  inputTax: TaxReportRow[];
}> {
  const outputRows = await tx`
    select
      i.tax_rate_bps,
      coalesce(tr.name_en, 'Unknown') as tax_rate_name,
      sum(i.subtotal_minor) as net_minor,
      sum(i.tax_minor) as tax_minor
    from invoices i
    left join tax_rates tr
      on tr.organization_id = i.organization_id
     and tr.rate_bps = i.tax_rate_bps
     and tr.is_active = true
    where i.organization_id = ${organizationId}
      and i.voided_at is null
      and i.issue_date >= ${from}::date
      and i.issue_date <= ${to}::date
    group by i.tax_rate_bps, tr.name_en
    order by i.tax_rate_bps desc
  `;

  const inputRows = await tx`
    select
      0 as tax_rate_bps,
      'N/A' as tax_rate_name,
      sum(b.total_minor) as net_minor,
      0::bigint as tax_minor
    from bills b
    where b.organization_id = ${organizationId}
      and b.voided_at is null
      and b.issue_date >= ${from}::date
      and b.issue_date <= ${to}::date
  `;

  return {
    outputTax: outputRows.map((row) => ({
      taxRateName: row.tax_rate_name as string,
      taxRate: Number(row.tax_rate_bps),
      netAmount: BigInt(row.net_minor as string),
      taxAmount: BigInt(row.tax_minor as string),
    })),
    inputTax: inputRows.map((row) => ({
      taxRateName: row.tax_rate_name as string,
      taxRate: Number(row.tax_rate_bps),
      netAmount: BigInt(row.net_minor as string),
      taxAmount: BigInt(row.tax_minor as string),
    })),
  };
}
