import type { Tx } from '@/server/db/transaction';

/**
 * 与数据库的 invoice_status 枚举逐项对应。
 *
 * 'partially_paid' 是 0009 迁移给枚举追加的值，而这个联合类型一直没跟上。
 * 后果不是编译错误而是更隐蔽的一种：refreshSettlementStatuses 每天都在往
 * 这一列写这个值，而任何写成 Record<InvoiceStatus, ...> 的映射（比如列表页
 * 的状态徽章）都会让 TypeScript 认定这个分支不可能出现——于是那些组件只能
 * 退回按 string 索引，把类型检查整个让出去。
 */
export type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'partially_paid'
  | 'paid'
  | 'overdue'
  | 'voided';

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

/**
 * 把过账产生的 transaction_id 写回发票。
 *
 * 这一列从 0008 建表起就存在，到这次改动之前**从未被写入过任何一行**——
 * 发票与它的分录之间没有任何连接，于是作废发票时找不到该连带作废哪笔交易，
 * 交易详情页也说不出这笔账是从哪张单据来的。
 *
 * where 里带 organization_id 而不是只认 id：RLS 已经挡住跨公司写入，但那是
 * 第二道；仓储层自己收窄公司维度是第一道，两道都在才不依赖某一条策略永远
 * 不被改错。
 */
export async function setInvoiceTransactionId(
  tx: Tx,
  organizationId: string,
  id: string,
  transactionId: string,
): Promise<void> {
  await tx`
    update invoices
    set transaction_id = ${transactionId}, updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/**
 * 作废发票：状态与 voided_at 一起写。
 *
 * 原来只有 setInvoiceStatus(…, 'voided')，voided_at 留空——而列表查询
 * （listInvoices）与税务报表（repositories/tax.ts 的 `i.voided_at is null`）
 * 读的是 voided_at，不是 status。于是一张「已作废」的发票在税务报表里仍然
 * 贡献着销项税。两个字段必须一起写。
 *
 * invoices 上没有 voided_by / void_reason 两列（只有 transactions 有），
 * 作废理由记在它那笔交易上，由 voidDocumentPosting 写。
 */
export async function markInvoiceVoided(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    update invoices
    set status = 'voided', voided_at = now(), updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/**
 * 下一个发票号。
 *
 * 原来是「按 created_at 取最近一张，解析它的号码，加一」，两处不对：
 *
 * 1. 取的是「最近创建的那张」，不是「号码最大的那张」。created_at 相同时
 *    排序不确定，而一旦最近那张的号码不合 INV-NNNNN 的形状，函数就整个
 *    退回 'INV-00001'——那个号通常早就被用掉了，于是必然撞唯一约束。
 *    库里现在就有 'INV-7eaba18b-2' 这种形状的历史数据。
 * 2. 没有并发保护。两个并发创建读到同一个最大号，算出同一个下一号。
 *    这一条在这里解决不了（见 withDocumentNumberRetry 里那段关于
 *    FOR UPDATE 为什么挡不住幻读的论证），由调用方的重试兜住。
 *
 * 改成在 SQL 里对合规号码的数字后缀取 max：与 created_at 无关，不合规的
 * 号码被忽略而不是让整个序列回到 1。
 *
 * 正则里用 [0-9] 而不是 \d：这是一个带标签的模板字符串，JS 会把 \d 的
 * 反斜杠在 cooked 串里吃掉（'\d' === 'd'），于是传到 Postgres 的是
 * '^INV-(d+)$'——匹配字面的字母 d，一张也匹配不到，max 恒为 0，每次都
 * 返回 INV-00001。这个坑不会报错，只会安静地把序列钉死在 1。
 */
export async function getNextInvoiceNumber(
  tx: Tx,
  organizationId: string,
): Promise<string> {
  const rows = await tx`
    select coalesce(max((substring(invoice_number from '^INV-([0-9]+)$'))::bigint), 0) as last
    from invoices
    where organization_id = ${organizationId}
      and invoice_number ~ '^INV-[0-9]+$'
  `;

  const next = BigInt(rows[0].last as string) + 1n;
  return `INV-${next.toString().padStart(5, '0')}`;
}
