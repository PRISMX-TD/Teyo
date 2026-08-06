import type { Tx } from '@/server/db/transaction';

export type ArAgingRow = {
  contactId: string;
  contactName: string;
  current: bigint;
  d31_60: bigint;
  d61_90: bigint;
  over90: bigint;
  total: bigint;
};

export type ApAgingRow = {
  contactId: string;
  contactName: string;
  current: bigint;
  d31_60: bigint;
  d61_90: bigint;
  over90: bigint;
  total: bigint;
};

export type StatementLine = {
  date: string;
  description: string;
  reference: string;
  amount: bigint;
  balance: bigint;
};

export type CustomerStatement = {
  openingBalance: bigint;
  lines: StatementLine[];
  closingBalance: bigint;
};

function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function getArAging(
  tx: Tx,
  organizationId: string,
  asOf: string,
): Promise<ArAgingRow[]> {
  const rows = await tx`
    select
      i.contact_id,
      c.name as contact_name,
      coalesce(sum(i.total_minor) filter (
        where i.due_date > ${asOf}::date - interval '30 days'
      ), 0) as current,
      coalesce(sum(i.total_minor) filter (
        where i.due_date <= ${asOf}::date - interval '30 days'
          and i.due_date > ${asOf}::date - interval '60 days'
      ), 0) as d31_60,
      coalesce(sum(i.total_minor) filter (
        where i.due_date <= ${asOf}::date - interval '60 days'
          and i.due_date > ${asOf}::date - interval '90 days'
      ), 0) as d61_90,
      coalesce(sum(i.total_minor) filter (
        where i.due_date <= ${asOf}::date - interval '90 days'
      ), 0) as over90,
      coalesce(sum(i.total_minor), 0) as total
    from invoices i
    join contacts c on c.id = i.contact_id
    where i.organization_id = ${organizationId}
      and i.status not in ('paid', 'voided')
      and i.voided_at is null
    group by i.contact_id, c.name
    order by sum(i.total_minor) desc, c.name
  `;

  return rows.map((row) => ({
    contactId: row.contact_id as string,
    contactName: row.contact_name as string,
    current: BigInt(row.current as string),
    d31_60: BigInt(row.d31_60 as string),
    d61_90: BigInt(row.d61_90 as string),
    over90: BigInt(row.over90 as string),
    total: BigInt(row.total as string),
  }));
}

export async function getApAging(
  tx: Tx,
  organizationId: string,
  asOf: string,
): Promise<ApAgingRow[]> {
  const rows = await tx`
    select
      b.contact_id,
      c.name as contact_name,
      coalesce(sum(b.total_minor) filter (
        where b.due_date > ${asOf}::date - interval '30 days'
      ), 0) as current,
      coalesce(sum(b.total_minor) filter (
        where b.due_date <= ${asOf}::date - interval '30 days'
          and b.due_date > ${asOf}::date - interval '60 days'
      ), 0) as d31_60,
      coalesce(sum(b.total_minor) filter (
        where b.due_date <= ${asOf}::date - interval '60 days'
          and b.due_date > ${asOf}::date - interval '90 days'
      ), 0) as d61_90,
      coalesce(sum(b.total_minor) filter (
        where b.due_date <= ${asOf}::date - interval '90 days'
      ), 0) as over90,
      coalesce(sum(b.total_minor), 0) as total
    from bills b
    join contacts c on c.id = b.contact_id
    where b.organization_id = ${organizationId}
      and b.status not in ('paid', 'voided')
      and b.voided_at is null
    group by b.contact_id, c.name
    order by sum(b.total_minor) desc, c.name
  `;

  return rows.map((row) => ({
    contactId: row.contact_id as string,
    contactName: row.contact_name as string,
    current: BigInt(row.current as string),
    d31_60: BigInt(row.d31_60 as string),
    d61_90: BigInt(row.d61_90 as string),
    over90: BigInt(row.over90 as string),
    total: BigInt(row.total as string),
  }));
}

export async function getCustomerStatement(
  tx: Tx,
  organizationId: string,
  contactId: string,
  from: string,
  to: string,
): Promise<CustomerStatement> {
  const openingRows = await tx`
    select
      coalesce(sum(i.total_minor), 0) as invoice_total,
      coalesce((
        select sum(pi.amount_minor)
        from payment_items pi
        join payments p on p.id = pi.payment_id
        where p.organization_id = ${organizationId}
          and p.contact_id = ${contactId}
          and p.voided_at is null
          and p.payment_date < ${from}::date
          and pi.invoice_id is not null
      ), 0) as payment_total,
      coalesce((
        select sum(cn.base_amount_minor)
        from credit_notes cn
        where cn.organization_id = ${organizationId}
          and cn.contact_id = ${contactId}
          and cn.status in ('issued', 'applied')
          and cn.voided_at is null
          and cn.issue_date < ${from}::date
      ), 0) as cn_total
  `;

  const openingBalance = BigInt(openingRows[0].invoice_total as string)
    - BigInt(openingRows[0].payment_total as string)
    - BigInt(openingRows[0].cn_total as string);

  const invoiceLines = await tx`
    select
      i.issue_date as date,
      'Invoice' as description,
      i.invoice_number as reference,
      i.total_minor as amount
    from invoices i
    where i.organization_id = ${organizationId}
      and i.contact_id = ${contactId}
      and i.status not in ('voided')
      and i.voided_at is null
      and i.issue_date >= ${from}::date
      and i.issue_date <= ${to}::date
    order by i.issue_date, i.id
  `;

  const paymentLines = await tx`
    select
      p.payment_date as date,
      'Payment' as description,
      p.reference,
      pi.amount_minor as amount
    from payment_items pi
    join payments p on p.id = pi.payment_id
    where p.organization_id = ${organizationId}
      and p.contact_id = ${contactId}
      and p.voided_at is null
      and pi.invoice_id is not null
      and p.payment_date >= ${from}::date
      and p.payment_date <= ${to}::date
    order by p.payment_date, p.id
  `;

  const cnLines = await tx`
    select
      cn.issue_date as date,
      'Credit Note' as description,
      cn.cn_number as reference,
      cn.base_amount_minor as amount
    from credit_notes cn
    where cn.organization_id = ${organizationId}
      and cn.contact_id = ${contactId}
      and cn.status in ('issued', 'applied')
      and cn.voided_at is null
      and cn.issue_date >= ${from}::date
      and cn.issue_date <= ${to}::date
    order by cn.issue_date, cn.id
  `;

  const allLines: { date: string; description: string; reference: string; amount: bigint }[] = [];
  for (const row of invoiceLines) {
    allLines.push({
      date: formatDateOnly(row.date as Date | string),
      description: row.description as string,
      reference: (row.reference as string) ?? '',
      amount: BigInt(row.amount as string),
    });
  }
  for (const row of paymentLines) {
    allLines.push({
      date: formatDateOnly(row.date as Date | string),
      description: row.description as string,
      reference: (row.reference as string) ?? '',
      amount: -BigInt(row.amount as string),
    });
  }
  for (const row of cnLines) {
    allLines.push({
      date: formatDateOnly(row.date as Date | string),
      description: row.description as string,
      reference: (row.reference as string) ?? '',
      amount: -BigInt(row.amount as string),
    });
  }
  allLines.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));

  let running = openingBalance;
  const statementLines: StatementLine[] = allLines.map((line) => {
    running = running + line.amount;
    return {
      date: line.date,
      description: line.description,
      reference: line.reference,
      amount: line.amount,
      balance: running,
    };
  });

  return {
    openingBalance,
    lines: statementLines,
    closingBalance: running,
  };
}

export async function getVendorStatement(
  tx: Tx,
  organizationId: string,
  contactId: string,
  from: string,
  to: string,
): Promise<CustomerStatement> {
  const openingRows = await tx`
    select
      coalesce(sum(b.total_minor), 0) as bill_total,
      coalesce((
        select sum(pi.amount_minor)
        from payment_items pi
        join payments p on p.id = pi.payment_id
        where p.organization_id = ${organizationId}
          and p.contact_id = ${contactId}
          and p.voided_at is null
          and p.payment_date < ${from}::date
          and pi.bill_id is not null
      ), 0) as payment_total
  `;

  const openingBalance = BigInt(openingRows[0].bill_total as string)
    - BigInt(openingRows[0].payment_total as string);

  const billLines = await tx`
    select
      b.issue_date as date,
      'Bill' as description,
      b.bill_number as reference,
      b.total_minor as amount
    from bills b
    where b.organization_id = ${organizationId}
      and b.contact_id = ${contactId}
      and b.status not in ('voided')
      and b.voided_at is null
      and b.issue_date >= ${from}::date
      and b.issue_date <= ${to}::date
    order by b.issue_date, b.id
  `;

  const paymentLines = await tx`
    select
      p.payment_date as date,
      'Payment' as description,
      p.reference,
      pi.amount_minor as amount
    from payment_items pi
    join payments p on p.id = pi.payment_id
    where p.organization_id = ${organizationId}
      and p.contact_id = ${contactId}
      and p.voided_at is null
      and pi.bill_id is not null
      and p.payment_date >= ${from}::date
      and p.payment_date <= ${to}::date
    order by p.payment_date, p.id
  `;

  const allLines: { date: string; description: string; reference: string; amount: bigint }[] = [];
  for (const row of billLines) {
    allLines.push({
      date: formatDateOnly(row.date as Date | string),
      description: row.description as string,
      reference: (row.reference as string) ?? '',
      amount: BigInt(row.amount as string),
    });
  }
  for (const row of paymentLines) {
    allLines.push({
      date: formatDateOnly(row.date as Date | string),
      description: row.description as string,
      reference: (row.reference as string) ?? '',
      amount: -BigInt(row.amount as string),
    });
  }
  allLines.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));

  let running = openingBalance;
  const statementLines: StatementLine[] = allLines.map((line) => {
    running = running + line.amount;
    return {
      date: line.date,
      description: line.description,
      reference: line.reference,
      amount: line.amount,
      balance: running,
    };
  });

  return {
    openingBalance,
    lines: statementLines,
    closingBalance: running,
  };
}