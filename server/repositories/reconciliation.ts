import type { Tx } from '@/server/db/transaction';

export type ReconciliationRow = {
  id: string;
  organizationId: string;
  moneyAccountId: string;
  statementDate: string;
  statementBalanceMinor: bigint;
  reconciledAt: string | null;
  createdBy: string;
  createdAt: string;
};

export type ReconciliationItemRow = {
  id: string;
  reconciliationId: string;
  transactionId: string | null;
  isCleared: boolean;
  adjustmentMinor: bigint;
  note: string | null;
};

function formatDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapReconciliation(row: Record<string, unknown>): ReconciliationRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    moneyAccountId: row.money_account_id as string,
    statementDate: formatDate(row.statement_date as Date | string),
    statementBalanceMinor: BigInt(row.statement_balance_minor as string),
    reconciledAt: row.reconciled_at
      ? (row.reconciled_at as Date).toISOString()
      : null,
    createdBy: row.created_by as string,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function mapItem(row: Record<string, unknown>): ReconciliationItemRow {
  return {
    id: row.id as string,
    reconciliationId: row.reconciliation_id as string,
    transactionId: (row.transaction_id as string | null) ?? null,
    isCleared: (row.is_cleared as boolean) ?? false,
    adjustmentMinor: BigInt((row.adjustment_minor as string) ?? '0'),
    note: (row.note as string | null) ?? null,
  };
}

export async function listReconciliations(
  tx: Tx,
  orgId: string,
  moneyAccountId: string,
): Promise<ReconciliationRow[]> {
  const rows = await tx`
    select id, organization_id, money_account_id, statement_date,
           statement_balance_minor, reconciled_at, created_by, created_at
    from bank_reconciliations
    where organization_id = ${orgId}
      and money_account_id = ${moneyAccountId}
    order by statement_date desc
  `;
  return rows.map(mapReconciliation);
}

export async function createReconciliation(
  tx: Tx,
  row: {
    organizationId: string;
    moneyAccountId: string;
    statementDate: string;
    statementBalanceMinor: bigint;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [inserted] = await tx`
    insert into bank_reconciliations (
      organization_id, money_account_id, statement_date,
      statement_balance_minor, created_by
    ) values (
      ${row.organizationId}, ${row.moneyAccountId}, ${row.statementDate}::date,
      ${row.statementBalanceMinor.toString()}, ${row.createdBy}
    )
    returning id
  `;
  return { id: inserted.id as string };
}

export async function getReconciliation(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ reconciliation: ReconciliationRow; items: ReconciliationItemRow[] } | null> {
  const rows = await tx`
    select id, organization_id, money_account_id, statement_date,
           statement_balance_minor, reconciled_at, created_by, created_at
    from bank_reconciliations
    where id = ${id} and organization_id = ${orgId}
  `;
  const row = rows.at(0);
  if (!row) return null;

  const itemRows = await tx`
    select id, reconciliation_id, transaction_id, is_cleared, adjustment_minor, note
    from reconciliation_items
    where reconciliation_id = ${id}
    order by id
  `;

  return {
    reconciliation: mapReconciliation(row),
    items: itemRows.map(mapItem),
  };
}

export async function addReconciliationItem(
  tx: Tx,
  row: {
    reconciliationId: string;
    transactionId: string | null;
    isCleared: boolean;
    adjustmentMinor: bigint;
    note: string | null;
  },
): Promise<{ id: string }> {
  const [inserted] = await tx`
    insert into reconciliation_items (
      reconciliation_id, transaction_id, is_cleared, adjustment_minor, note
    ) values (
      ${row.reconciliationId}, ${row.transactionId},
      ${row.isCleared}, ${row.adjustmentMinor.toString()},
      ${row.note}
    )
    returning id
  `;
  return { id: inserted.id as string };
}

export async function updateReconciliationItem(
  tx: Tx,
  id: string,
  cleared: boolean,
  adjustment: bigint,
): Promise<void> {
  await tx`
    update reconciliation_items
    set is_cleared = ${cleared}, adjustment_minor = ${adjustment.toString()}
    where id = ${id}
  `;
}

export async function completeReconciliation(
  tx: Tx,
  id: string,
): Promise<void> {
  await tx`
    update bank_reconciliations
    set reconciled_at = now()
    where id = ${id}
  `;
}

/** 查找未对账的交易：该资金账户下未被任何 reconciliation_items 引用的交易。 */
export type UnreconciledTransaction = {
  id: string;
  occurredOn: string;
  description: string;
  kind: string;
  amountMinor: bigint;
  currency: string;
};

export async function listUnreconciledTransactions(
  tx: Tx,
  orgId: string,
  moneyAccountId: string,
): Promise<UnreconciledTransaction[]> {
  const rows = await tx`
    select t.id, t.occurred_on, t.description, t.kind, t.amount_minor, t.currency
    from transactions t
    join journal_lines l on l.transaction_id = t.id and l.organization_id = ${orgId}
    where t.organization_id = ${orgId}
      and t.voided_at is null
      and l.account_id = ${moneyAccountId}
      and t.id not in (
        select coalesce(ri.transaction_id, '00000000-0000-0000-0000-000000000000')
        from reconciliation_items ri
        join bank_reconciliations br on br.id = ri.reconciliation_id
        where br.organization_id = ${orgId}
          and br.money_account_id = ${moneyAccountId}
      )
    order by t.occurred_on desc, t.created_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    occurredOn: formatDate(r.occurred_on as Date | string),
    description: r.description as string,
    kind: r.kind as string,
    amountMinor: BigInt(r.amount_minor as string),
    currency: r.currency as string,
  }));
}

/** 计算指定资金账户的账面余额（未清帐的所有交易净额）。 */
export async function getBookBalance(
  tx: Tx,
  orgId: string,
  moneyAccountId: string,
): Promise<bigint> {
  const [row] = await tx`
    select coalesce(sum(
      case when l.direction = 'debit' then l.amount_minor::bigint
           else -l.amount_minor::bigint end
    ), 0) as balance
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    where l.organization_id = ${orgId}
      and l.account_id = ${moneyAccountId}
      and t.voided_at is null
  `;
  return BigInt(row.balance as string);
}
