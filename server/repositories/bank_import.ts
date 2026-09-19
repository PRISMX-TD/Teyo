import type { Tx } from '@/server/db/transaction';

/**
 * 单个对账单文件的大小上限。
 *
 * 常量放在仓库层而不是 Action 里，与 server/repositories/attachments.ts 的
 * MAX_ATTACHMENT_BYTES 同一个道理——也因为 `'use server'` 模块只允许导出
 * async 函数，常量放在那边会让构建直接失败。
 *
 * 对照附件上传：那边有 MIME 白名单加字节上限两道，而这条路径过去一道都没有，
 * 只检查了 `file instanceof File`。next.config.ts 的
 * serverActions.bodySizeLimit 是 12mb，也就是说任何人都能往这个入口塞一个
 * 12MB 的文件，而它会被整个读进内存、整份解析、再整批插进一个事务。
 *
 * 4MB 有充足余量：CSV 对账单每行约 100 字节，4MB 够放四万行。
 */
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

/**
 * 单次导入的行数上限。
 *
 * 光有字节上限不够：一个 4MB 的文件里能塞几十万行极短的记录。而
 * insertImportedTransactions 是一条巨大的 `insert ... values (...), (...)`，
 * 跑在一个事务里——生产连接池只有 3 条连接（server/db/client.ts 的 max: 3），
 * 一条长事务占住一条，三份这样的文件同时上传就把整个应用卡死了。
 *
 * 5000 行约等于一家小商户两年的流水，超过就该分批导入。
 */
export const MAX_IMPORT_ROWS = 5000;

export type ImportStatus = 'pending' | 'matched' | 'ignored';
export type ImportSource = 'csv' | 'ofx' | 'qif';

export type ImportedTransactionRow = {
  id: string;
  organizationId: string;
  moneyAccountId: string;
  source: ImportSource;
  rawData: Record<string, unknown>;
  transactionDate: string;
  description: string | null;
  amountMinor: bigint;
  matchedTransactionId: string | null;
  status: ImportStatus;
  createdAt: string;
  createdBy: string;
};

export type ImportedTransactionFilters = {
  moneyAccountId?: string;
  status?: ImportStatus;
};

export type ImportedTxnInput = {
  organizationId: string;
  moneyAccountId: string;
  source: ImportSource;
  /**
   * 写入侧收窄成 string -> string，而不是读出侧那个 unknown。
   *
   * 解析器产出的本来就是「原始单元格的文字」，全是字符串；而 tx.json() 的
   * 形参类型 JSONValue 不接受 unknown（那正是它存在的意义——挡住 bigint、
   * symbol 这类 JSON.stringify 会悄悄弄坏的值）。之前这里是
   * `tx.json(row.rawData as any)`，一个 `as any` 把这道检查整个关掉了，
   * 也是 `npm run lint` 长期红着的三个错误之一。
   */
  rawData: Record<string, string>;
  transactionDate: string;
  description: string | null;
  amountMinor: bigint;
  createdBy: string;
};

function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapRow(row: Record<string, unknown>): ImportedTransactionRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    moneyAccountId: row.money_account_id as string,
    source: row.source as ImportSource,
    rawData: (row.raw_data as Record<string, unknown>) ?? {},
    transactionDate: formatDateOnly(row.transaction_date as Date | string),
    description: (row.description as string | null) ?? null,
    amountMinor: BigInt(row.amount_minor as string),
    matchedTransactionId: (row.matched_transaction_id as string | null) ?? null,
    status: row.status as ImportStatus,
    createdAt: (row.created_at as Date).toISOString(),
    createdBy: row.created_by as string,
  };
}

export async function listImportedTransactions(
  tx: Tx,
  organizationId: string,
  filters?: ImportedTransactionFilters,
): Promise<ImportedTransactionRow[]> {
  const rows = await tx`
    select
      id, organization_id, money_account_id, source, raw_data,
      transaction_date, description, amount_minor,
      matched_transaction_id, status, created_at, created_by
    from imported_transactions
    where organization_id = ${organizationId}
      ${filters?.moneyAccountId ? tx`and money_account_id = ${filters.moneyAccountId}::uuid` : tx``}
      ${filters?.status ? tx`and status = ${filters.status}::import_status` : tx``}
    order by transaction_date desc, created_at desc
  `;

  return rows.map(mapRow);
}

export async function insertImportedTransactions(
  tx: Tx,
  rows: ImportedTxnInput[],
): Promise<void> {
  if (rows.length === 0) return;

  await tx`
    insert into imported_transactions ${tx(
      rows.map((row) => ({
        organization_id: row.organizationId,
        money_account_id: row.moneyAccountId,
        source: row.source,
        raw_data: tx.json(row.rawData),
        transaction_date: row.transactionDate,
        description: row.description,
        amount_minor: row.amountMinor.toString(),
        created_by: row.createdBy,
      })),
      'organization_id',
      'money_account_id',
      'source',
      'raw_data',
      'transaction_date',
      'description',
      'amount_minor',
      'created_by',
    )}
  `;
}

export async function matchImportedTransaction(
  tx: Tx,
  organizationId: string,
  id: string,
  matchedTransactionId: string,
): Promise<void> {
  await tx`
    update imported_transactions
    set matched_transaction_id = ${matchedTransactionId}, status = 'matched'
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function ignoreImportedTransaction(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    update imported_transactions
    set status = 'ignored'
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function resetImportedTransaction(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    update imported_transactions
    set status = 'pending', matched_transaction_id = null
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function deleteImportedTransactions(
  tx: Tx,
  organizationId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;

  await tx`
    delete from imported_transactions
    where organization_id = ${organizationId} and id = any(${ids}::uuid[])
  `;
}
