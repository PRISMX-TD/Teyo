import type { Tx } from '@/server/db/transaction';
import { LedgerError } from '@/server/domain/ledger';
import { sumCreditNotedByInvoice } from '@/server/repositories/credit_notes';

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

/**
 * transaction_id 不在这里。
 *
 * 它原来是 createPayment 的入参之一（zod 里 `transactionId: uuid().nullable()`），
 * 由客户端传入、不做任何校验就原样入库。外键只保证那一行确实存在于
 * transactions 里，**不保证它属于本公司**——PostgreSQL 的外键校验不受 RLS
 * 约束，这正是 server/posting/insert.ts 的 assertAccountsBelongToOrg 专门堵
 * 的那一类洞。于是任何人都能把自己的一笔收款挂到别家公司的交易上。
 *
 * 这个字段现在完全由服务端过账产生：先 insertPayment 拿到 id，再 postJournal
 * 记账，最后 setPaymentTransactionId 写回。客户端没有任何机会插手。
 */
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
      reference, notes, created_by
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
      ${row.createdBy}
    )
    returning id
  `;
  return { id: inserted[0].id as string };
}

/**
 * 把过账产生的交易 id 写回收付款。
 *
 * organization_id 收窄不可省：RLS 挡得住非成员，但用户同属两家公司时两边
 * 的策略都通过，只剩这个条件在挡。
 */
export async function setPaymentTransactionId(
  tx: Tx,
  organizationId: string,
  id: string,
  transactionId: string,
): Promise<void> {
  await tx`
    update payments set transaction_id = ${transactionId}
    where id = ${id} and organization_id = ${organizationId}
  `;
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

// ============================================================
// 预收 / 预付款：还没核销到任何单据的那一部分
// ============================================================

/**
 * 一笔收付款里「还没有单据」的余额 = amount_minor − Σ payment_items。
 *
 * 为什么是**算出来的**而不是存一行「未核销 7,000」的 payment_items：
 *
 *   0024 把 payment_items_one_target 放宽成「至多一个非空」之后，确实可以
 *   插一条两列都为空的明细来代表挂账的那一截，而且那样
 *   `payments.amount_minor = Σ payment_items` 会成为一条恒等式，看上去更整齐。
 *   代价在**日后核销**那一步：核销 3,000 就必须把那条 7,000 的行改成 4,000，
 *   也就是 UPDATE 一条已经写下的明细。账本这一侧从不改写历史——收付款、
 *   分录、单据状态全是「只新增、只作废」。为了一条恒等式换来一处 UPDATE，
 *   而那处 UPDATE 还要自己保证并发下不会把余额改成负数，不划算。
 *
 *   现在的做法是：核销就往同一笔收付款上**追加**一条指向单据的明细，余额
 *   自然减少。任何时刻的余额都由一条 sum 查询给出，没有第二个真相来源。
 *
 * 只算未作废的收付款：作废的那一笔上的明细不该让任何单据显示为已付，
 * 同理它自己的余额也不该被谁核销。
 */
export async function sumAppliedByPayment(
  tx: Tx,
  organizationId: string,
  paymentIds: readonly string[],
): Promise<Map<string, bigint>> {
  if (paymentIds.length === 0) return new Map();

  const rows = await tx`
    select p.id as payment_id, coalesce(sum(pi.amount_minor), 0) as applied
    from payments p
    left join payment_items pi on pi.payment_id = p.id
    where p.organization_id = ${organizationId}
      and p.id = any(${[...paymentIds]}::uuid[])
    group by p.id
  `;

  return new Map(rows.map((row) => [row.payment_id as string, BigInt(row.applied as string)]));
}

/** 一笔还有未核销余额的收付款，够界面把它列出来并核销掉。 */
export type OpenPrepayment = {
  id: string;
  contactId: string;
  contactName: string;
  type: 'received' | 'made';
  currency: string;
  paymentDate: string;
  reference: string | null;
  amountMinor: bigint;
  appliedMinor: bigint;
  /** amountMinor − appliedMinor，恒大于零（否则这一行不会出现在结果里）。 */
  unappliedMinor: bigint;
};

/**
 * 列出所有还挂着钱的预收/预付款。
 *
 * having 里的判断放在 SQL 而不是取回来再 filter：一家开了三年的公司有几千
 * 笔收付款，其中有余额的通常只有几笔，把筛选留给数据库才不会每次打开
 * 收款页都把全部历史读进内存。
 *
 * voided_at is null 不可省：作废的收款上那笔钱已经不在账上了，它不该出现
 * 在「可以核销的定金」列表里——真让人点下去，核销分录会去借一个已经被
 * 反过账的预收余额。
 */
export async function listOpenPrepayments(
  tx: Tx,
  organizationId: string,
): Promise<OpenPrepayment[]> {
  const rows = await tx`
    select
      p.id, p.contact_id, c.name as contact_name, p.type, p.currency,
      p.payment_date, p.reference, p.amount_minor,
      coalesce(sum(pi.amount_minor), 0) as applied_minor
    from payments p
    join contacts c on c.id = p.contact_id
    left join payment_items pi on pi.payment_id = p.id
    where p.organization_id = ${organizationId}
      and p.voided_at is null
    group by p.id, c.name
    having p.amount_minor > coalesce(sum(pi.amount_minor), 0)
    order by p.payment_date desc, p.created_at desc, p.id desc
  `;

  return rows.map((row) => {
    const amountMinor = BigInt(row.amount_minor as string);
    const appliedMinor = BigInt(row.applied_minor as string);
    return {
      id: row.id as string,
      contactId: row.contact_id as string,
      contactName: row.contact_name as string,
      type: row.type as 'received' | 'made',
      currency: row.currency as string,
      paymentDate: formatDateOnly(row.payment_date as Date | string),
      reference: (row.reference as string | null) ?? null,
      amountMinor,
      appliedMinor,
      unappliedMinor: amountMinor - appliedMinor,
    };
  });
}

// ============================================================
// 结算：被核销的单据、已核销金额、单据状态
// ============================================================

export type SettlementDocumentKind = 'invoice' | 'bill';

/**
 * 一张被收付款核销的单据，连同它在总账里那一笔分录的样子。
 *
 * postedBaseAmountMinor 是汇兑损益的 R1 来源。它取自 transactions，不是
 * 单据行——invoices / bills 上根本没有 exchange_rate 或 base_amount_minor
 * 列（0008 建表时没有，0021 也没补），而且即便有，要对齐的也是总账里实际
 * 躺着的那个数。推导见 server/services/fx-settlement.ts 顶部注释。
 */
export type SettlementDocument = {
  id: string;
  kind: SettlementDocumentKind;
  /** 单号，只用于错误文案与凭证摘要。 */
  number: string;
  currency: string;
  totalMinor: bigint;
  status: string;
  transactionId: string | null;
  /** 过账交易的本位币金额；单据未过账、或那笔交易已作废时为 null。 */
  postedBaseAmountMinor: bigint | null;
  /** 过账交易的原币金额。与 totalMinor 不一致时说明单据在过账后被改过。 */
  postedAmountMinor: bigint | null;
};

function mapSettlementDocument(
  row: Record<string, unknown>,
  kind: SettlementDocumentKind,
): SettlementDocument {
  const postedBase = row.posted_base_amount_minor as string | null;
  const postedAmount = row.posted_amount_minor as string | null;

  return {
    id: row.id as string,
    kind,
    number: (row.number as string | null) ?? '',
    currency: row.currency as string,
    totalMinor: BigInt(row.total_minor as string),
    status: row.status as string,
    transactionId: (row.transaction_id as string | null) ?? null,
    postedBaseAmountMinor: postedBase === null ? null : BigInt(postedBase),
    postedAmountMinor: postedAmount === null ? null : BigInt(postedAmount),
  };
}

/**
 * 按 id 取发票，并 left join 出它的过账交易。
 *
 * organization_id 条件是本函数存在的第二个理由：payment_items.invoice_id
 * 上的外键只保证那张发票存在，不保证它属于本公司（外键不受 RLS 约束）。
 * 调用方按「要过的 id 一个都不能少」核对返回的 Map，少一个就说明请求里
 * 混进了别家公司的单据，直接抛错。
 *
 * 过账交易被作废时 postedBaseAmountMinor 取不到值：那笔应收已经不在账上，
 * 没有任何东西需要被真平。
 */
export async function loadInvoicesForSettlement(
  tx: Tx,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, SettlementDocument>> {
  if (ids.length === 0) return new Map();

  const rows = await tx`
    select
      i.id, i.invoice_number as number, i.currency, i.total_minor, i.status,
      i.transaction_id,
      t.base_amount_minor as posted_base_amount_minor,
      t.amount_minor as posted_amount_minor
    from invoices i
    left join transactions t
      on t.id = i.transaction_id
     and t.organization_id = i.organization_id
     and t.voided_at is null
    where i.organization_id = ${organizationId}
      and i.id = any(${[...ids]}::uuid[])
  `;

  return new Map(
    rows.map((row) => [row.id as string, mapSettlementDocument(row, 'invoice')]),
  );
}

/** loadInvoicesForSettlement 的应付侧对偶。bills.bill_number 可以为 null。 */
export async function loadBillsForSettlement(
  tx: Tx,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, SettlementDocument>> {
  if (ids.length === 0) return new Map();

  const rows = await tx`
    select
      b.id, b.bill_number as number, b.currency, b.total_minor, b.status,
      b.transaction_id,
      t.base_amount_minor as posted_base_amount_minor,
      t.amount_minor as posted_amount_minor
    from bills b
    left join transactions t
      on t.id = b.transaction_id
     and t.organization_id = b.organization_id
     and t.voided_at is null
    where b.organization_id = ${organizationId}
      and b.id = any(${[...ids]}::uuid[])
  `;

  return new Map(
    rows.map((row) => [row.id as string, mapSettlementDocument(row, 'bill')]),
  );
}

/**
 * 每张单据上「已经收/付了多少」（原币），只算未作废的收付款。
 *
 * excludePaymentId 供两种调用方使用：录入时要的是「本次之前」的累计，而
 * 本次的 payment_items 可能已经写进去了；作废时要的是「除这一笔之外」的
 * 累计。两种需求同一个形状，不必写两个函数。
 *
 * 返回 Map 而不是数组：调用方永远是按单据 id 查，数组会逼它自己再建一个
 * 索引，而那正是漏掉某一张单据时最难看出来的地方。
 */
export async function sumSettledByDocument(
  tx: Tx,
  organizationId: string,
  kind: SettlementDocumentKind,
  ids: readonly string[],
  opts?: { excludePaymentId?: string },
): Promise<Map<string, bigint>> {
  if (ids.length === 0) return new Map();

  const exclude = opts?.excludePaymentId ?? null;

  const rows =
    kind === 'invoice'
      ? await tx`
          select pi.invoice_id as document_id, coalesce(sum(pi.amount_minor), 0) as settled
          from payment_items pi
          join payments p on p.id = pi.payment_id
          where p.organization_id = ${organizationId}
            and p.voided_at is null
            and (${exclude}::uuid is null or p.id <> ${exclude}::uuid)
            and pi.invoice_id = any(${[...ids]}::uuid[])
          group by pi.invoice_id
        `
      : await tx`
          select pi.bill_id as document_id, coalesce(sum(pi.amount_minor), 0) as settled
          from payment_items pi
          join payments p on p.id = pi.payment_id
          where p.organization_id = ${organizationId}
            and p.voided_at is null
            and (${exclude}::uuid is null or p.id <> ${exclude}::uuid)
            and pi.bill_id = any(${[...ids]}::uuid[])
          group by pi.bill_id
        `;

  return new Map(rows.map((row) => [row.document_id as string, BigInt(row.settled as string)]));
}

/**
 * 发票/账单的结算状态。
 *
 * 这四个值取自 0008/0009 的 invoice_status / bill_status 两个枚举，
 * 'partially_paid' 由 0009 追加。server/repositories/invoices.ts 与
 * bills.ts 上的 TypeScript 类型**漏了这个值**（两个文件都停在
 * 'draft' | 'sent' | 'paid' | 'overdue' | 'voided'），所以它们的
 * setInvoiceStatus / setBillStatus 在类型上根本表达不出部分收款——这也是
 * 这一对函数没有复用它们的原因。两个文件不归本次改动所有，已在报告里记下。
 */
export type SettlementStatus = 'paid' | 'partially_paid' | 'sent' | 'received';

/**
 * 按已核销金额推出单据应有的状态。
 *
 * 'draft' 与 'voided' 一律不动：草稿还没发出去，作废的单据不该因为一笔
 * 历史收款被复活。'overdue' 也不动到「未付」那一档——逾期是一个关于日期
 * 的判断，不是关于金额的，把它改成 'sent' 等于抹掉一条真实信息；但全额
 * 收讫时它必须变成 'paid'，否则逾期列表会一直挂着一张已经收完的发票。
 *
 * 归零那一支（settled = 0）存在是为了作废收款：不把 'paid' 退回去的话，
 * 一笔被作废的收款会让发票永远显示已付。
 */
export function settlementStatusFor(args: {
  kind: SettlementDocumentKind;
  currentStatus: string;
  totalMinor: bigint;
  settledMinor: bigint;
}): SettlementStatus | null {
  const { kind, currentStatus, totalMinor, settledMinor } = args;

  if (currentStatus === 'draft' || currentStatus === 'voided') return null;

  const unpaid: SettlementStatus = kind === 'invoice' ? 'sent' : 'received';

  if (settledMinor >= totalMinor && totalMinor > 0n) {
    return currentStatus === 'paid' ? null : 'paid';
  }
  if (settledMinor > 0n) {
    return currentStatus === 'partially_paid' ? null : 'partially_paid';
  }
  if (currentStatus === 'paid' || currentStatus === 'partially_paid') {
    return unpaid;
  }
  return null;
}

/**
 * 写单据状态。
 *
 * 为什么不用 server/repositories/{invoices,bills}.ts 已有的
 * setInvoiceStatus / setBillStatus：它们的入参类型里没有 'partially_paid'
 * （见 SettlementStatus 上的注释），传进去就是类型错误。表名按 kind 分成
 * 两条语句而不是拼字符串——拼出来的表名是注入面，且这里只有两种可能。
 */
export async function setSettlementStatus(
  tx: Tx,
  organizationId: string,
  kind: SettlementDocumentKind,
  id: string,
  status: SettlementStatus,
): Promise<void> {
  if (kind === 'invoice') {
    await tx`
      update invoices set status = ${status}::invoice_status, updated_at = now()
      where id = ${id} and organization_id = ${organizationId}
    `;
    return;
  }

  await tx`
    update bills set status = ${status}::bill_status, updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/**
 * 按「现在一共核销了多少」重算一批单据的状态。
 *
 * 发票那一侧要把贷项通知单也算进去：一张 1,000 的发票收了 800、另有一张
 * 200 的贷项通知单，它就是收讫了，而只看 payment_items 会让它永远停在
 * 「部分收款」。账单那一侧没有对应的单据类型（credit_notes.invoice_id 只
 * 指向发票），所以只算收付款。
 *
 * 只在状态真的要变时才写：每次收款都 update 一遍全部单据会把 updated_at
 * 搅乱，而那一列是列表页的排序依据。
 *
 * 放在 repository 而不是某个 action 里，是因为收付款与贷项通知单两个入口
 * 都要用它，而 'use server' 文件只能导出 async 函数、不能当共享模块使。
 */
export async function refreshSettlementStatuses(
  tx: Tx,
  organizationId: string,
  kind: SettlementDocumentKind,
  documents: ReadonlyMap<string, SettlementDocument>,
): Promise<void> {
  const ids = [...documents.keys()];
  if (ids.length === 0) return;

  const settled = await sumSettledByDocument(tx, organizationId, kind, ids);
  const creditNoted =
    kind === 'invoice'
      ? await sumCreditNotedByInvoice(tx, organizationId, ids)
      : new Map<string, bigint>();

  for (const [id, document] of documents) {
    const status = settlementStatusFor({
      kind,
      currentStatus: document.status,
      totalMinor: document.totalMinor,
      settledMinor: (settled.get(id) ?? 0n) + (creditNoted.get(id) ?? 0n),
    });
    if (status === null) continue;
    await setSettlementStatus(tx, organizationId, kind, id, status);
  }
}

/**
 * 收付款落在哪个资金科目上。
 *
 * payments 表没有账户列——0009 建表时只有一个 method 枚举。所以资金科目
 * 只能从 method 推：现金收付进 'cash'，其余（转账/支票/在线/其他）进
 * 'bank'。这是本次改动里唯一一个「猜」出来的映射，把它写成一个具名常量
 * 而不是散在 if 里，是为了让下一个给 payments 加账户列的人一眼看见它该被
 * 替换掉。
 *
 * 这两个 code 没有走 server/services/posting-accounts.ts 的
 * resolvePostingAccounts：那个函数的 PostingAccountCode 类型取自
 * POSTING_ACCOUNT_CODES，而那张表里只有单据过账用的控制科目，没有
 * 'cash' / 'bank'。account-seed.ts 不属于本次改动，已在报告里记下。
 */
export const MONEY_ACCOUNT_CODE_BY_METHOD = {
  cash: 'cash',
  bank_transfer: 'bank',
  cheque: 'bank',
  online: 'bank',
  other: 'bank',
} as const;

export type PaymentMethod = keyof typeof MONEY_ACCOUNT_CODE_BY_METHOD;

/**
 * 取本公司某个资金科目的 id。
 *
 * 同时核实 is_money_account——把一笔银行收款记到「销售收入」上，分录照样
 * 配平、触发器照样放行，只有看报表的人会发现银行余额从来不动。科目被停用
 * 不影响这里：停用只决定它出不出现在选择器里，系统自动记账仍然要能落地
 * （同 resolvePostingAccounts 的处理）。
 */
export async function findMoneyAccountId(
  tx: Tx,
  organizationId: string,
  code: string,
): Promise<string> {
  const rows = await tx`
    select id from accounts
    where organization_id = ${organizationId}
      and code = ${code}
      and is_money_account = true
  `;

  const row = rows.at(0);
  if (!row) {
    throw new LedgerError(
      `This company has no money account with code "${code}". ` +
        'Ask an owner or admin to restore it under Settings › Chart of accounts.',
    );
  }
  return row.id as string;
}
