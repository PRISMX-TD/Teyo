import type { Tx } from '@/server/db/transaction';

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
  rawData: Record<string, unknown>;
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
        raw_data: tx.json(row.rawData as any),
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
