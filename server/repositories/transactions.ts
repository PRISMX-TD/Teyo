import type { Tx } from '@/server/db/transaction';
import type { TransactionKind } from '@/server/domain/ledger';
import { formatScaledRate } from '@/server/domain/exchange-rate';
import type { RateSource } from '@/server/domain/exchange-rate';
import { parseDecimalToMinor } from '@/server/domain/money';

// insertTransaction / insertJournalLines / deleteJournalLines 都已搬到
// server/posting/insert.ts，只对 server/posting/ 内部导出——postJournal /
// repostJournal 是记账凭证的唯一写入出口。见该文件顶部注释。这个仓储文件
// 之后只留读取。

/** client_uuid 是离线幂等键，唯一约束是 (organization_id, client_uuid)。 */
export async function findTransactionByClientUuid(
  tx: Tx,
  organizationId: string,
  clientUuid: string,
): Promise<{ id: string } | null> {
  const rows = await tx`
    select id from transactions
    where organization_id = ${organizationId} and client_uuid = ${clientUuid}
  `;
  const row = rows.at(0);
  return row ? { id: row.id as string } : null;
}

export type TransactionListRow = {
  id: string;
  kind: TransactionKind;
  occurredOn: string;
  description: string;
  currency: string;
  amountMinor: bigint;
  baseAmountMinor: bigint;
  exchangeRate: string;
  rateSource: RateSource;
  categoryId: string | null;
  projectId: string | null;
  categoryNameEn: string | null;
  categoryNameZh: string | null;
  moneyAccountId: string | null;
  moneyAccountNameEn: string | null;
  moneyAccountNameZh: string | null;
  createdBy: string;
  createdByName: string;
  attachmentCount: number;
  voidedAt: string | null;
  voidReason: string | null;
};

export type TransactionFilters = {
  from?: string;
  to?: string;
  kind?: TransactionKind;
  categoryId?: string;
  moneyAccountId?: string;
  createdBy?: string;
  minAmount?: string;
  maxAmount?: string;
  keyword?: string;
  includeVoided?: boolean;
};

/** date 列在 postgres.js 里回来是 Date 对象，统一转回 YYYY-MM-DD。 */
export function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // 不能用 toISOString()：它先转 UTC，在 UTC+8 下会把 2026-03-01 变成 2026-02-28。
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 金额筛选比的是 base_amount_minor，所以按本位币的小数位解析。
 *
 * 这里固定用 2 位而不是查公司本位币：JPY 之类零小数币种作为本位币时会不准，
 * 但当前 UI 只允许两位小数币种建账（见 lib/schemas.ts 的 positiveAmount）。
 */
function toMinorOrNull(value: string | undefined): string | null {
  return value ? parseDecimalToMinor(value, 2).toString() : null;
}

type FilterParams = {
  includeVoided: boolean;
  from: string | null;
  to: string | null;
  kind: string | null;
  categoryId: string | null;
  createdBy: string | null;
  moneyAccountId: string | null;
  minMinor: string | null;
  maxMinor: string | null;
  keyword: string | null;
};

function toParams(filters: TransactionFilters): FilterParams {
  return {
    includeVoided: filters.includeVoided ?? false,
    from: filters.from ?? null,
    to: filters.to ?? null,
    kind: filters.kind ?? null,
    categoryId: filters.categoryId ?? null,
    createdBy: filters.createdBy ?? null,
    moneyAccountId: filters.moneyAccountId ?? null,
    minMinor: toMinorOrNull(filters.minAmount),
    maxMinor: toMinorOrNull(filters.maxAmount),
    keyword: filters.keyword ?? null,
  };
}

/**
 * 每个筛选都写成「参数为 null 就恒真」，这样一条 SQL 覆盖所有组合，
 * 不必拼字符串，全部值仍走绑定参数，没有注入面。
 */
function whereClause(tx: Tx, organizationId: string, p: FilterParams) {
  return tx`
    t.organization_id = ${organizationId}
    and (${p.includeVoided} or t.voided_at is null)
    and (${p.from}::date is null or t.occurred_on >= ${p.from}::date)
    and (${p.to}::date is null or t.occurred_on <= ${p.to}::date)
    and (${p.kind}::transaction_kind is null or t.kind = ${p.kind}::transaction_kind)
    and (${p.categoryId}::uuid is null or t.category_id = ${p.categoryId}::uuid)
    and (${p.createdBy}::uuid is null or t.created_by = ${p.createdBy}::uuid)
    and (${p.moneyAccountId}::uuid is null or m.account_id = ${p.moneyAccountId}::uuid)
    and (${p.minMinor}::bigint is null or t.base_amount_minor >= ${p.minMinor}::bigint)
    and (${p.maxMinor}::bigint is null or t.base_amount_minor <= ${p.maxMinor}::bigint)
    and (${p.keyword}::text is null or t.description ilike '%' || ${p.keyword}::text || '%')
  `;
}

/**
 * 资金账户是分录里挂在 is_money_account 科目上的那一行。
 * 收入与转账时它在借方、支出时在贷方，所以按 is_money_account 找而不是按方向找。
 * 转账两行都是资金账户，distinct on 配合 order by direction 取借方（转入方）。
 */
function moneyLineCte(tx: Tx, organizationId: string) {
  return tx`
    select distinct on (l.transaction_id)
      l.transaction_id, a.id as account_id, a.name_en, a.name_zh
    from journal_lines l
    join accounts a on a.id = l.account_id
    where l.organization_id = ${organizationId} and a.is_money_account
    order by l.transaction_id, l.direction
  `;
}

/**
 * 分页列出交易。organization_id 收窄不可省：用户同属两家公司时 RLS 对两边
 * 都放行，此时唯一挡住跨公司泄露的就是这个条件。
 */
export async function listTransactions(
  tx: Tx,
  organizationId: string,
  filters: TransactionFilters,
  page: { limit: number; offset: number },
): Promise<{ rows: TransactionListRow[]; total: number }> {
  if (!Number.isInteger(page.limit) || page.limit < 1) {
    throw new Error(`listTransactions requires a positive integer limit, received ${page.limit}.`);
  }
  if (!Number.isInteger(page.offset) || page.offset < 0) {
    throw new Error(
      `listTransactions requires a non-negative integer offset, received ${page.offset}.`,
    );
  }

  const p = toParams(filters);

  const rows = await tx`
    with money_line as (${moneyLineCte(tx, organizationId)})
    select
      t.id, t.kind, t.occurred_on, t.description, t.currency,
      t.amount_minor, t.base_amount_minor, t.exchange_rate, t.rate_source,
      t.category_id, t.project_id, t.created_by, t.voided_at, t.void_reason, t.created_at,
      c.name_en as category_name_en,
      c.name_zh as category_name_zh,
      m.account_id as money_account_id,
      m.name_en as money_account_name_en,
      m.name_zh as money_account_name_zh,
      u.display_name as created_by_name,
      (select count(*) from attachments at where at.transaction_id = t.id) as attachment_count,
      count(*) over () as total_count
    from transactions t
    left join categories c on c.id = t.category_id
    left join money_line m on m.transaction_id = t.id
    join app_users u on u.id = t.created_by
    where ${whereClause(tx, organizationId, p)}
    order by t.occurred_on desc, t.created_at desc, t.id desc
    limit ${page.limit} offset ${page.offset}
  `;

  // 空页时 count(*) over () 一行都没有，只能另查一次。
  const total =
    rows.length > 0
      ? Number(rows[0].total_count)
      : await countTransactions(tx, organizationId, filters);

  return { total, rows: rows.map(mapListRow) };
}

function mapListRow(row: Record<string, unknown>): TransactionListRow {
  return {
    id: row.id as string,
    kind: row.kind as TransactionKind,
    occurredOn: formatDateOnly(row.occurred_on as Date | string),
    description: row.description as string,
    currency: row.currency as string,
    amountMinor: BigInt(row.amount_minor as string),
    baseAmountMinor: BigInt(row.base_amount_minor as string),
    exchangeRate: String(row.exchange_rate),
    rateSource: row.rate_source as RateSource,
    categoryId: (row.category_id as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    categoryNameEn: (row.category_name_en as string | null) ?? null,
    categoryNameZh: (row.category_name_zh as string | null) ?? null,
    moneyAccountId: (row.money_account_id as string | null) ?? null,
    moneyAccountNameEn: (row.money_account_name_en as string | null) ?? null,
    moneyAccountNameZh: (row.money_account_name_zh as string | null) ?? null,
    createdBy: row.created_by as string,
    createdByName: row.created_by_name as string,
    attachmentCount: Number(row.attachment_count),
    voidedAt: row.voided_at ? (row.voided_at as Date).toISOString() : null,
    voidReason: (row.void_reason as string | null) ?? null,
  };
}

/**
 * 结果为空时的总数。筛选条件必须与主查询完全一致，
 * 否则空页会报出一个对不上的总数，前端的分页控件会显示不存在的页。
 */
async function countTransactions(
  tx: Tx,
  organizationId: string,
  filters: TransactionFilters,
): Promise<number> {
  const p = toParams(filters);

  const [row] = await tx`
    with money_line as (${moneyLineCte(tx, organizationId)})
    select count(*)::int as total
    from transactions t
    left join money_line m on m.transaction_id = t.id
    where ${whereClause(tx, organizationId, p)}
  `;

  return Number(row.total);
}

export type TransactionDetail = TransactionListRow & {
  counterAccountId: string | null;
  lines: {
    accountId: string;
    accountCode: string;
    accountNameEn: string | null;
    accountNameZh: string | null;
    direction: 'debit' | 'credit';
    amountMinor: bigint;
  }[];
  attachments: {
    id: string;
    fileName: string;
    storagePath: string;
    mimeType: string;
    sizeBytes: number;
  }[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TransactionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionNotFoundError';
  }
}

/**
 * 读一笔交易的完整内容，含分录与附件。
 *
 * 找不到时抛 TransactionNotFoundError 而不是返回 null：调用方全都是要改这笔
 * 记录，静默的 null 只会在后面变成更难查的空指针。
 */
export async function getTransactionDetail(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<TransactionDetail> {
  // id 来自地址栏（/transactions/<id>）或 Server Action 的入参。不是 uuid 的串
  // 直接交给 Postgres 会抛 22P02，详情页只认 TransactionNotFoundError，于是
  // 一个手敲错的链接变成整页 500。语义上它就是「找不到」。
  if (!UUID_PATTERN.test(id)) {
    throw new TransactionNotFoundError('This record was not found in this company.');
  }

  const heads = await tx`
    with money_line as (${moneyLineCte(tx, organizationId)})
    select
      t.id, t.kind, t.occurred_on, t.description, t.currency,
      t.amount_minor, t.base_amount_minor, t.exchange_rate, t.rate_source,
      t.category_id, t.project_id, t.created_by, t.voided_at, t.void_reason,
      c.name_en as category_name_en,
      c.name_zh as category_name_zh,
      m.account_id as money_account_id,
      m.name_en as money_account_name_en,
      m.name_zh as money_account_name_zh,
      u.display_name as created_by_name,
      (select count(*) from attachments at where at.transaction_id = t.id) as attachment_count
    from transactions t
    left join categories c on c.id = t.category_id
    left join money_line m on m.transaction_id = t.id
    join app_users u on u.id = t.created_by
    where t.id = ${id} and t.organization_id = ${organizationId}
  `;

  const head = heads.at(0);
  if (!head) {
    throw new TransactionNotFoundError('This record was not found in this company.');
  }

  const lines = await tx`
    select l.account_id, a.code, a.name_en, a.name_zh, a.is_money_account,
           l.direction, l.amount_minor
    from journal_lines l
    join accounts a on a.id = l.account_id
    where l.transaction_id = ${id} and l.organization_id = ${organizationId}
    order by l.direction
  `;

  const attachments = await tx`
    select id, file_name, storage_path, mime_type, size_bytes
    from attachments
    where transaction_id = ${id} and organization_id = ${organizationId}
    order by created_at
  `;

  const moneyAccountId = head.money_account_id as string | null;
  // 对方科目是「不是资金账户的那行」；转账两行都是资金账户，
  // 于是退回到「account_id 与资金行不同的那行」。
  const counterLine =
    lines.find((line) => !line.is_money_account) ??
    lines.find((line) => line.account_id !== moneyAccountId);

  return {
    ...mapListRow({ ...head, created_at: null }),
    counterAccountId: (counterLine?.account_id as string | undefined) ?? null,
    lines: lines.map((line) => ({
      accountId: line.account_id as string,
      accountCode: line.code as string,
      accountNameEn: (line.name_en as string | null) ?? null,
      accountNameZh: (line.name_zh as string | null) ?? null,
      direction: line.direction as 'debit' | 'credit',
      amountMinor: BigInt(line.amount_minor as string),
    })),
    attachments: attachments.map((row) => ({
      id: row.id as string,
      fileName: row.file_name as string,
      storagePath: row.storage_path as string,
      mimeType: row.mime_type as string,
      sizeBytes: Number(row.size_bytes),
    })),
  };
}

export type TransactionHeadUpdate = {
  occurredOn: string;
  description: string;
  currency: string;
  amountMinor: bigint;
  baseAmountMinor: bigint;
  scaledRate: bigint;
  rateSource: RateSource;
  categoryId: string | null;
  /**
   * 交易归属的项目。null 表示不挂项目。
   *
   * transactions.project_id 这一列 0009 就加了，而在此之前**没有任何地方
   * 给它写过值**——server/repositories/projects.ts 的项目盈亏查询一直在
   * 按它聚合，算出来的恒定是零。查询侧写对了，写入侧从来没接上。
   */
  projectId: string | null;
};

/**
 * organization_id 收窄同样不可省。RLS 的 transactions_update 策略会挡住
 * 非成员，但用户同属两家公司时两边都通过，只剩这个条件在挡。
 */
export async function updateTransactionHead(
  tx: Tx,
  organizationId: string,
  id: string,
  row: TransactionHeadUpdate,
): Promise<void> {
  await tx`
    update transactions set
      occurred_on = ${row.occurredOn},
      description = ${row.description},
      currency = ${row.currency},
      amount_minor = ${row.amountMinor.toString()},
      base_amount_minor = ${row.baseAmountMinor.toString()},
      exchange_rate = ${formatScaledRate(row.scaledRate)},
      rate_source = ${row.rateSource},
      category_id = ${row.categoryId},
      project_id = ${row.projectId},
      updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/** 软删除。voided_at / voided_by / void_reason 三者必须同时写入（表级 check 约束）。 */
export async function markVoided(
  tx: Tx,
  organizationId: string,
  id: string,
  userId: string,
  reason: string,
): Promise<void> {
  await tx`
    update transactions
    set voided_at = now(), voided_by = ${userId}, void_reason = ${reason}, updated_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export type TransactionSourceType =
  | 'invoice'
  | 'bill'
  | 'credit_note'
  | 'payment'
  | 'depreciation'
  | 'year_end'
  | 'asset_disposal';

/**
 * 一笔分录是哪张单据生成的。
 *
 * id 是「该链接到的那张单据」的 id，不一定是指向这笔交易的那一行：折旧
 * 分录指向的是 depreciation_schedules 的某一期，但界面上能打开的只有固定
 * 资产详情页，所以这里给的是资产 id。label 是给人看的编号（发票号、账单号、
 * 资产名 + 期间……），可能为空串（账单号是可选列）。
 */
export type TransactionSource = {
  type: TransactionSourceType;
  id: string;
  label: string;
};

/**
 * 查这笔交易是不是由某张单据生成的。
 *
 * transactions 上没有「来源」列，是单据反过来指向交易：invoices / bills /
 * credit_notes / payments / depreciation_schedules / fiscal_year_closings
 * 的 transaction_id，以及 fixed_assets.disposal_transaction_id。一条
 * UNION ALL 查完，每一支都按公司收窄——depreciation_schedules 自己没有
 * organization_id，借 fixed_assets 那一列收窄。
 *
 * 不算来源的：imported_transactions.matched_transaction_id。那是「这条银行
 * 流水对上了哪笔账」，账本身可能是用户手录的；作废之后由用户在导入页把那
 * 一行重置回待处理（见 server/repositories/bank-import.ts 的
 * importedTransactionPostingUuid），不需要在这里拦。
 */
export async function findTransactionSource(
  tx: Tx,
  organizationId: string,
  transactionId: string,
): Promise<TransactionSource | null> {
  if (!UUID_PATTERN.test(transactionId)) return null;

  const rows = await tx`
    select 'invoice' as type, i.id, i.invoice_number as label, 1 as rank
    from invoices i
    where i.organization_id = ${organizationId} and i.transaction_id = ${transactionId}
    union all
    select 'bill', b.id, coalesce(b.bill_number, ''), 2
    from bills b
    where b.organization_id = ${organizationId} and b.transaction_id = ${transactionId}
    union all
    select 'credit_note', cn.id, cn.cn_number, 3
    from credit_notes cn
    where cn.organization_id = ${organizationId} and cn.transaction_id = ${transactionId}
    union all
    select 'payment', p.id,
           coalesce(nullif(btrim(p.reference), ''), to_char(p.payment_date, 'YYYY-MM-DD')), 4
    from payments p
    where p.organization_id = ${organizationId} and p.transaction_id = ${transactionId}
    union all
    select 'depreciation', fa.id, fa.name || ' · ' || to_char(ds.period, 'YYYY-MM'), 5
    from depreciation_schedules ds
    join fixed_assets fa on fa.id = ds.fixed_asset_id
    where fa.organization_id = ${organizationId} and ds.transaction_id = ${transactionId}
    union all
    select 'year_end', fyc.id,
           to_char(fyc.period_start, 'YYYY-MM-DD') || ' – ' || to_char(fyc.period_end, 'YYYY-MM-DD'),
           6
    from fiscal_year_closings fyc
    where fyc.organization_id = ${organizationId} and fyc.transaction_id = ${transactionId}
    union all
    select 'asset_disposal', fa.id, fa.name, 7
    from fixed_assets fa
    where fa.organization_id = ${organizationId}
      and fa.disposal_transaction_id = ${transactionId}
    order by rank
    limit 1
  `;

  const row = rows.at(0);
  if (!row) return null;
  return {
    type: row.type as TransactionSourceType,
    id: row.id as string,
    label: (row.label as string | null) ?? '',
  };
}
