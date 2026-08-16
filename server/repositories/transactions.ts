import type { Tx } from '@/server/db/transaction';
import type { DraftJournalLine, TransactionKind } from '@/server/domain/ledger';
import { formatScaledRate } from '@/server/domain/exchange-rate';
import type { RateSource } from '@/server/domain/exchange-rate';
import { parseDecimalToMinor } from '@/server/domain/money';

export type NewTransactionRow = {
  organizationId: string;
  kind: TransactionKind;
  occurredOn: string;
  description: string;
  currency: string;
  amountMinor: bigint;
  baseAmountMinor: bigint;
  scaledRate: bigint;
  rateSource: RateSource;
  categoryId: string | null;
  createdBy: string;
  clientUuid: string;
};

/**
 * exchange_rate 列是 numeric(20,8)，而应用内部用放大 10^8 的 bigint。
 * 这里转成十进制字符串写入，全程不经 Number，避免浮点误差改动汇率。
 * formatScaledRate 会裁掉尾部零，numeric 列不在意这个。
 */
export async function insertTransaction(
  tx: Tx,
  row: NewTransactionRow,
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into transactions (
      organization_id, kind, occurred_on, description, currency,
      amount_minor, base_amount_minor, exchange_rate, rate_source,
      category_id, created_by, client_uuid
    )
    values (
      ${row.organizationId},
      ${row.kind},
      ${row.occurredOn},
      ${row.description},
      ${row.currency},
      ${row.amountMinor.toString()},
      ${row.baseAmountMinor.toString()},
      ${formatScaledRate(row.scaledRate)},
      ${row.rateSource},
      ${row.categoryId},
      ${row.createdBy},
      ${row.clientUuid}
    )
    returning id
  `;

  return { id: inserted[0].id as string };
}

export async function insertJournalLines(
  tx: Tx,
  organizationId: string,
  transactionId: string,
  lines: DraftJournalLine[],
): Promise<void> {
  if (lines.length === 0) return;

  await tx`
    insert into journal_lines ${tx(
      lines.map((line) => ({
        transaction_id: transactionId,
        organization_id: organizationId,
        account_id: line.accountId,
        direction: line.direction,
        // bigint 列传十进制字符串：驱动类型定义不接受 bigint 参数，
        // 而字符串由 Postgres 直接解析，不经浮点，精度无损。
        amount_minor: line.amountMinor.toString(),
        base_amount_minor: line.baseAmountMinor.toString(),
      })),
      'transaction_id',
      'organization_id',
      'account_id',
      'direction',
      'amount_minor',
      'base_amount_minor',
    )}
  `;
}

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
      t.category_id, t.created_by, t.voided_at, t.void_reason, t.created_at,
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
  const heads = await tx`
    with money_line as (${moneyLineCte(tx, organizationId)})
    select
      t.id, t.kind, t.occurred_on, t.description, t.currency,
      t.amount_minor, t.base_amount_minor, t.exchange_rate, t.rate_source,
      t.category_id, t.created_by, t.voided_at, t.void_reason,
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

export async function deleteJournalLines(
  tx: Tx,
  organizationId: string,
  transactionId: string,
): Promise<void> {
  await tx`
    delete from journal_lines
    where transaction_id = ${transactionId} and organization_id = ${organizationId}
  `;
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
