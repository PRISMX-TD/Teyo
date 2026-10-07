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
  /**
   * 放大 10^8 的定标整数（0009 建表时就是 bigint，0021 刻意没有改列类型）。
   *
   * 类型从 string 改成 bigint，与 PaymentRow.exchangeRate 一致：原来带出来的
   * 是 "470000000" 这样的裸字符串，任何拿到它的人都得自己知道「这不是 4.7」。
   * 字符串 <-> 定标整数的换算只走 server/domain/exchange-rate.ts 的
   * parseRateToScaled / formatScaledRate 这一对，别处不再各写一遍——
   * 也绝不出现 BigInt(userInput) 这种把用户输入的 "1.5" 当整数读的写法。
   */
  exchangeRate: bigint;
  baseAmountMinor: bigint;
  reason: string | null;
  notes: string | null;
  /** 过账产生的交易 id。由 0021 迁移加上这一列；完全由服务端写入。 */
  transactionId: string | null;
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
  /** 该行税率（基点）。没挂税率时为 0，由下面那个 left join 带出来。 */
  taxRateBps: number;
};

/**
 * contactName 不在这里。
 *
 * 它原来是 NewCreditNoteRow 与 CreditNoteUpdate 的一个字段，insertCreditNote
 * 也真的把它写进一个叫 contact_name 的列——而 credit_notes 上**从来没有过
 * 这一列**（0009 建表时没有，之后所有迁移里都没有 `contact_name` 这个词）。
 * 结果是 createCreditNote 从上线那天起每一次调用都在
 * `column "contact_name" of relation "credit_notes" does not exist` 上失败，
 * 这个功能一次都没有成功过。
 *
 * 列表页展示的 contactName 与它无关：那是 mapListRow 从 contacts join 出来
 * 的 c.name，一直是对的。所以修法是删掉这条写入，而不是加一列——多加一列
 * 等于把客户名字复制一份到单据上，然后等着它与 contacts 里的那份不一致。
 */
export type NewCreditNoteRow = {
  organizationId: string;
  invoiceId: string | null;
  contactId: string;
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
    exchangeRate: BigInt(row.exchange_rate as string),
    baseAmountMinor: BigInt(row.base_amount_minor as string),
    reason: (row.reason as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    transactionId: (row.transaction_id as string | null) ?? null,
    voidedAt: row.voided_at ? (row.voided_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    createdBy: row.created_by as string,
  };
}

function mapItemRow(row: Record<string, unknown>): CreditNoteItemRow {
  return {
    id: row.id as string,
    creditNoteId: row.credit_note_id as string,
    description: row.description as string,
    quantity: row.quantity as string,
    unitPriceMinor: BigInt(row.unit_price_minor as string),
    amountMinor: BigInt(row.amount_minor as string),
    taxRateId: (row.tax_rate_id as string | null) ?? null,
    taxRateBps: Number(row.tax_rate_bps ?? 0),
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
      cn.reason, cn.notes, cn.transaction_id, cn.voided_at,
      cn.created_at, cn.created_by,
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
      cn.reason, cn.notes, cn.transaction_id, cn.voided_at,
      cn.created_at, cn.created_by,
      c.name as contact_name
    from credit_notes cn
    join contacts c on c.id = cn.contact_id
    where cn.id = ${id} and cn.organization_id = ${organizationId}
  `;

  const row = rows.at(0);
  if (!row) return null;

  // 税率跟着明细一起带回来：过账时要按行算税，而 credit_notes 表上既没有
  // subtotal_minor 也没有 tax_minor（invoices 有，0021 也没给 CN 补）。
  // tax_rates 上有 organization_id，join 时收窄一次——tax_rate_id 的外键
  // 不保证那条税率属于本公司（外键不受 RLS 约束）。
  const items = await tx`
    select cni.id, cni.credit_note_id, cni.description,
           cni.quantity::text as quantity,
           cni.unit_price_minor, cni.amount_minor, cni.tax_rate_id,
           coalesce(tr.rate_bps, 0) as tax_rate_bps
    from credit_note_items cni
    left join tax_rates tr
      on tr.id = cni.tax_rate_id
     and tr.organization_id = ${organizationId}
    where cni.credit_note_id = ${id}
    order by cni.id
  `;

  return {
    ...mapListRow(row),
    items: items.map(mapItemRow),
  };
}

/**
 * 一张贷项通知单的净额 / 税额 / 总额，全部原币、全部整数运算。
 *
 * 为什么按行算税而不是按整单算：credit_note_items.tax_rate_id 是逐行的，
 * 一张单上可以混着 6% SST 与免税两种行。按整单一个税率算，等于凭空给
 * 免税行也算上税。invoices 走的是「整单一个 tax_rate_bps」，那是它自己
 * 表结构的形状，两者不是同一件事，不该硬凑成同一个公式。
 *
 * 舍入用 half-up 的整数写法 (a * bps * 2 + 10000) / 20000，与
 * server/domain/exchange-rate.ts 的 convertToBaseMinor 同一种形状。
 * server/actions/invoices.ts 里那句 `(subTotalMinor * bps) / 10000n` 是
 * **截断**，6% 的税在 1.25 上会少收一分——那个文件不归本次改动所有，已在
 * 报告里记下。这里不复制它。
 *
 * 放在 repository 而不是 domain：它消费的正是上面那条查询返回的行，两者
 * 挨着才看得出「税率是 left join 出来的、缺失时为 0」这件事；而
 * server/domain/ 下没有一个既有文件是讲单据形状的。
 */
export function creditNoteAmountsMinor(
  items: readonly { amountMinor: bigint; taxRateBps: number }[],
): { netMinor: bigint; taxMinor: bigint; totalMinor: bigint } {
  let netMinor = 0n;
  let taxMinor = 0n;

  for (const item of items) {
    const bps = BigInt(Math.trunc(item.taxRateBps));
    if (bps < 0n) {
      throw new Error(`Credit note item has a negative tax rate: ${item.taxRateBps}`);
    }
    netMinor += item.amountMinor;
    taxMinor += (item.amountMinor * bps * 2n + 10000n) / 20000n;
  }

  return { netMinor, taxMinor, totalMinor: netMinor + taxMinor };
}

/**
 * 取一组税率的基点值。
 *
 * organization_id 收窄不可省：credit_note_items.tax_rate_id 的外键只保证那
 * 条税率存在，不保证它属于本公司（外键不受 RLS 约束）。调用方按「要的 id
 * 一个都不能少」核对返回的 Map——少一个就说明入参里混进了别家公司的税率，
 * 而静默当成 0% 会让一张含税的贷项通知单少冲一截应收。
 */
export async function loadTaxRateBps(
  tx: Tx,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await tx`
    select id, rate_bps from tax_rates
    where organization_id = ${organizationId} and id = any(${unique}::uuid[])
  `;

  return new Map(rows.map((row) => [row.id as string, Number(row.rate_bps)]));
}

/**
 * 每张发票被贷项通知单冲掉了多少（原币）。
 *
 * 只算 issued / applied 且未作废的——草稿还没发出去，作废的已经不算数，
 * 与 server/repositories/aging.ts 的客户对账单用的是同一组条件。
 *
 * 金额走 creditNoteAmountsMinor 而不是在 SQL 里再写一遍那个 half-up 公式：
 * 两份实现里写反一个，从另一边完全看不出来，而这正是本仓库反复要消灭的
 * 那种「第二份实现」。代价是把明细行拉回来在 JS 里合计，一次收款涉及的
 * 发票通常是个位数，值得。
 */
export async function sumCreditNotedByInvoice(
  tx: Tx,
  organizationId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, bigint>> {
  if (invoiceIds.length === 0) return new Map();

  const rows = await tx`
    select cn.invoice_id, cni.amount_minor, coalesce(tr.rate_bps, 0) as tax_rate_bps
    from credit_notes cn
    join credit_note_items cni on cni.credit_note_id = cn.id
    left join tax_rates tr
      on tr.id = cni.tax_rate_id
     and tr.organization_id = ${organizationId}
    where cn.organization_id = ${organizationId}
      and cn.voided_at is null
      and cn.status in ('issued', 'applied')
      and cn.invoice_id = any(${[...invoiceIds]}::uuid[])
  `;

  const itemsByInvoice = new Map<string, { amountMinor: bigint; taxRateBps: number }[]>();
  for (const row of rows) {
    const invoiceId = row.invoice_id as string;
    const bucket = itemsByInvoice.get(invoiceId) ?? [];
    bucket.push({
      amountMinor: BigInt(row.amount_minor as string),
      taxRateBps: Number(row.tax_rate_bps),
    });
    itemsByInvoice.set(invoiceId, bucket);
  }

  return new Map(
    [...itemsByInvoice].map(([invoiceId, items]) => [
      invoiceId,
      creditNoteAmountsMinor(items).totalMinor,
    ]),
  );
}

export async function insertCreditNote(
  tx: Tx,
  row: NewCreditNoteRow,
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into credit_notes (
      organization_id, invoice_id, contact_id, cn_number, status,
      issue_date, currency, exchange_rate, base_amount_minor, reason, notes, created_by
    )
    values (
      ${row.organizationId},
      ${row.invoiceId},
      ${row.contactId},
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

/**
 * 把过账产生的交易 id 写回贷项通知单（0021 新加的那一列）。
 *
 * 完全由服务端过账产生，入参里没有这个字段——payments 的同名字段此前由
 * 客户端传入且不校验，见 server/repositories/payments.ts 上 NewPaymentRow
 * 的注释；新加的这一列一开始就不留那个口子。
 */
export async function setCreditNoteTransactionId(
  tx: Tx,
  organizationId: string,
  id: string,
  transactionId: string,
): Promise<void> {
  await tx`
    update credit_notes set transaction_id = ${transactionId}
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
