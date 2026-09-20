import type { Tx } from '@/server/db/transaction';

/** 与数据库的 bill_status 枚举逐项对应。理由见 invoices.ts 的 InvoiceStatus。 */
export type BillStatus =
  | 'draft'
  | 'received'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'voided';

export type BillListRow = {
  id: string;
  billNumber: string | null;
  status: BillStatus;
  issueDate: string;
  dueDate: string;
  currency: string;
  /**
   * 净额 / 税率 / 税额三列由 0021 迁移补上。此前 bills 只有 total_minor，
   * 一张含 6% SST 的供应商账单，税额只能并进费用科目——repositories/tax.ts
   * 里那句 `0::bigint as tax_minor`（进项恒为 0）正是这个缺列的直接后果，
   * 不是查询写错了。invoices 从 0008 起就有这三列，bills 一直没有。
   */
  subtotalMinor: bigint;
  taxRateBps: number;
  taxMinor: bigint;
  /**
   * 用户选中的那条 tax_rates 记录。与 taxRateBps 是两件事——后者是税率
   * 数值，这个是「选的是哪一条」。详见 NewBillRow 上同名字段的注释。
   */
  taxRateId: string | null;
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
  subtotalMinor: bigint;
  taxRateBps: number;
  taxMinor: bigint;
  totalMinor: bigint;
  /**
   * 账单适用的税率记录（0021 加的列）。
   *
   * 与 taxRateBps 是两件事：后者是税率**数值**，决定算出多少税；这个是
   * 「用户选的是哪一条税率」。两者都要存——税率记录会被改名、被停用，
   * 税率本身也会调整（SST 从 6% 调到 8% 时，历史账单上的 6% 必须留在
   * tax_rate_bps 里不动，而「当初选的是标准税率这一条」只有这个 id 说得出来）。
   *
   * 归属由 server/actions/bills.ts 的 assertTaxRateBelongsToOrg 校验：
   * 这条外键只保证那一行存在，不保证属于哪家公司，而 RLS 不对外键校验生效。
   */
  taxRateId: string | null;
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
  subtotalMinor?: bigint;
  taxRateBps?: number;
  taxMinor?: bigint;
  taxRateId?: string | null;
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
    subtotalMinor: BigInt(row.subtotal_minor as string),
    taxRateBps: Number(row.tax_rate_bps),
    taxMinor: BigInt(row.tax_minor as string),
    taxRateId: (row.tax_rate_id as string | null) ?? null,
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
      b.currency, b.subtotal_minor, b.tax_rate_bps, b.tax_minor, b.tax_rate_id,
      b.total_minor, b.notes, b.contact_id,
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
      b.currency, b.subtotal_minor, b.tax_rate_bps, b.tax_minor, b.tax_rate_id,
      b.total_minor, b.notes, b.contact_id,
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
      issue_date, due_date, currency, subtotal_minor,
      tax_rate_bps, tax_minor, total_minor, tax_rate_id, notes
    )
    values (
      ${row.organizationId},
      ${row.contactId},
      ${row.billNumber},
      ${row.status},
      ${row.issueDate},
      ${row.dueDate},
      ${row.currency},
      ${row.subtotalMinor.toString()},
      ${row.taxRateBps},
      ${row.taxMinor.toString()},
      ${row.totalMinor.toString()},
      ${row.taxRateId},
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
  if (fields.subtotalMinor !== undefined) sets.subtotal_minor = fields.subtotalMinor.toString();
  if (fields.taxRateBps !== undefined) sets.tax_rate_bps = fields.taxRateBps;
  if (fields.taxMinor !== undefined) sets.tax_minor = fields.taxMinor.toString();
  if (fields.taxRateId !== undefined) sets.tax_rate_id = fields.taxRateId;
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

/** 把过账产生的 transaction_id 写回账单。理由见 invoices.ts 的同名函数。 */
export async function setBillTransactionId(
  tx: Tx,
  organizationId: string,
  id: string,
  transactionId: string,
): Promise<void> {
  await tx`
    update bills
    set transaction_id = ${transactionId}, updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/**
 * 作废账单：状态与 voided_at 一起写。
 *
 * 只写 status 的话，读 voided_at 的那些查询（listBills、
 * repositories/tax.ts 的进项统计）看不见这次作废——一张「已作废」的账单
 * 仍然贡献着进项税。作废理由记在它那笔交易上，bills 没有那两列。
 */
export async function markBillVoided(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    update bills
    set status = 'voided', voided_at = now(), updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/**
 * 下一个账单号。逐条理由见 server/repositories/invoices.ts 的
 * getNextInvoiceNumber——两处的问题与改法完全相同，包括正则里必须写
 * [0-9] 而不是 \d（标签模板会把反斜杠吃掉，于是一张都匹配不到、序列
 * 安静地钉死在 1）。
 *
 * bills.bill_number 允许为 null（唯一约束里 null 不参与唯一性），
 * `~` 对 null 返回 null，where 自然把它们滤掉，不必另写一句。
 */
export async function getNextBillNumber(
  tx: Tx,
  organizationId: string,
): Promise<string> {
  const rows = await tx`
    select coalesce(max((substring(bill_number from '^BILL-([0-9]+)$'))::bigint), 0) as last
    from bills
    where organization_id = ${organizationId}
      and bill_number ~ '^BILL-[0-9]+$'
  `;

  const next = BigInt(rows[0].last as string) + 1n;
  return `BILL-${next.toString().padStart(5, '0')}`;
}
