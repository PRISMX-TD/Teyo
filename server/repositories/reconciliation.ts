import type { Tx } from '@/server/db/transaction';

export class ReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

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

/**
 * 勾掉（或取消勾掉）对账清单上的一行。
 *
 * organizationId 这个参数是补上去的，而它的缺席不是「设计上靠 RLS」——
 * 同一个文件里 getReconciliation / listReconciliations 都老老实实带了公司
 * 维度，只有这两个写入函数漏了，调用方手里明明握着 context.organizationId
 * 也没往下传。漏掉的后果：只凭一个 id 就能改别人公司的对账行。
 *
 * 为什么 RLS 兜不住这件事——它兜得住「不是任何一家公司的成员」，兜不住
 * 「是 A 公司的成员，但把 B 公司的 id 传了进来」。这个应用里谁都能再建
 * 一家公司，所以「同时属于两家公司」是常态而不是边角情况。
 *
 * reconciliation_items 表上没有 organization_id 列（见 0008 迁移），公司维度
 * 只存在于父表 bank_reconciliations 上，所以这里必须 join 上去过滤，不能
 * 简单地在 where 里加一个列。
 *
 * count === 0 要报错而不是默默返回：静默的「零行更新」会让界面显示成功，
 * 用户以为勾上了，下次打开又没勾——比报错难查得多。
 */
export async function updateReconciliationItem(
  tx: Tx,
  organizationId: string,
  id: string,
  cleared: boolean,
  adjustment: bigint,
): Promise<void> {
  const result = await tx`
    update reconciliation_items ri
    set is_cleared = ${cleared}, adjustment_minor = ${adjustment.toString()}
    from bank_reconciliations br
    where ri.id = ${id}
      and br.id = ri.reconciliation_id
      and br.organization_id = ${organizationId}
  `;
  if (result.count === 0) {
    throw new ReconciliationError('That reconciliation line was not found in this company.');
  }
}

/** 收尾一次对账。organization_id 的理由同 updateReconciliationItem。 */
export async function completeReconciliation(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  const result = await tx`
    update bank_reconciliations
    set reconciled_at = now()
    where id = ${id} and organization_id = ${organizationId}
  `;
  if (result.count === 0) {
    throw new ReconciliationError('That reconciliation was not found in this company.');
  }
}

/**
 * 从一批交易 id 里挑出确实属于本公司、且未作废的那些。
 *
 * 存在的理由：reconcile 会把客户端传来的每个 id 直接当 transaction_id 插进
 * reconciliation_items，而这张表的外键只指向 transactions(id)，没有公司维度
 * （0008 迁移）。也就是说，只要 id 真实存在，别家公司的交易就能被挂进本公司
 * 的一次对账里——之后它会出现在对账清单上、影响清帐差额，而 RLS 对
 * 「成员把外公司 id 传进来」这一种是无感的。
 *
 * 返回命中的集合而不是逐个查：一次往返，且调用方可以用「数量对不上」直接
 * 判死，不必关心是哪一个不对（对用户来说「清单里有不属于这家公司的记录」
 * 就是同一件事）。
 */
export async function filterOwnTransactionIds(
  tx: Tx,
  organizationId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const rows = await tx`
    select id from transactions
    where organization_id = ${organizationId}
      and voided_at is null
      and id = any(${ids}::uuid[])
  `;
  return new Set(rows.map((row) => row.id as string));
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
