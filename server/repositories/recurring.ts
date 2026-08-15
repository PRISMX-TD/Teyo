import type { Tx } from '@/server/db/transaction';
import type { TransactionKind } from '@/server/domain/ledger';

export type RecurringTransactionRow = {
  id: string;
  organizationId: string;
  kind: TransactionKind;
  description: string | null;
  amount: string;
  currency: string;
  debitAccountId: string;
  creditAccountId: string;
  categoryId: string | null;
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  interval: number;
  startDate: string;
  endDate: string | null;
  nextDueDate: string;
  isActive: boolean;
  createdAt: string;
};

function formatDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapRecurring(row: Record<string, unknown>): RecurringTransactionRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    kind: row.kind as TransactionKind,
    description: (row.description as string | null) ?? null,
    amount: row.amount as string,
    currency: row.currency as string,
    debitAccountId: row.debit_account_id as string,
    creditAccountId: row.credit_account_id as string,
    categoryId: (row.category_id as string | null) ?? null,
    frequency: row.frequency as RecurringTransactionRow['frequency'],
    interval: Number(row.interval),
    startDate: formatDate(row.start_date as Date | string),
    endDate: row.end_date ? formatDate(row.end_date as Date | string) : null,
    nextDueDate: formatDate(row.next_due_date as Date | string),
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function listRecurring(
  tx: Tx,
  orgId: string,
): Promise<RecurringTransactionRow[]> {
  const rows = await tx`
    select id, organization_id, kind, description, amount, currency,
           debit_account_id, credit_account_id, category_id,
           frequency, "interval", start_date, end_date, next_due_date,
           is_active, created_at
    from recurring_transactions
    where organization_id = ${orgId}
    order by next_due_date asc
  `;
  return rows.map(mapRecurring);
}

export async function insertRecurring(
  tx: Tx,
  row: {
    organizationId: string;
    kind: TransactionKind;
    description: string | null;
    amount: string;
    currency: string;
    debitAccountId: string;
    creditAccountId: string;
    categoryId: string | null;
    frequency: RecurringTransactionRow['frequency'];
    interval: number;
    startDate: string;
    endDate: string | null;
    nextDueDate: string;
  },
): Promise<{ id: string }> {
  const [inserted] = await tx`
    insert into recurring_transactions (
      organization_id, kind, description, amount, currency,
      debit_account_id, credit_account_id, category_id,
      frequency, "interval", start_date, end_date, next_due_date
    ) values (
      ${row.organizationId}, ${row.kind}, ${row.description},
      ${row.amount}, ${row.currency},
      ${row.debitAccountId}, ${row.creditAccountId}, ${row.categoryId},
      ${row.frequency}, ${row.interval},
      ${row.startDate}::date, ${row.endDate ? row.endDate + '::date' : null},
      ${row.nextDueDate}::date
    )
    returning id
  `;
  return { id: inserted.id as string };
}

export async function updateRecurring(
  tx: Tx,
  orgId: string,
  id: string,
  fields: {
    description?: string | null;
    amount?: string;
    currency?: string;
    debitAccountId?: string;
    creditAccountId?: string;
    categoryId?: string | null;
    frequency?: RecurringTransactionRow['frequency'];
    interval?: number;
    startDate?: string;
    endDate?: string | null;
    nextDueDate?: string;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const column = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    patch[column] = value;
  }

  const columns = Object.keys(patch);
  if (columns.length === 0) return;

  // postgres.js 的 tx(obj, ...cols) 形式生成参数化的 "col" = $n 列表，
  // 日期列传字符串即可，Postgres 会按目标列类型隐式转换，
  // 不需要（也不能）内联 ::date —— 内联会退回字符串拼接。
  await tx`
    update recurring_transactions
    set ${tx(patch, ...columns)}
    where id = ${id} and organization_id = ${orgId}
  `;
}

export async function setRecurringActive(
  tx: Tx,
  orgId: string,
  id: string,
  active: boolean,
): Promise<void> {
  await tx`
    update recurring_transactions
    set is_active = ${active}
    where id = ${id} and organization_id = ${orgId}
  `;
}

/** 返回在今天（含）之前到期的活跃定期交易。 */
export async function getDueRecurring(
  tx: Tx,
  orgId: string,
  today: string,
): Promise<RecurringTransactionRow[]> {
  const rows = await tx`
    select id, organization_id, kind, description, amount, currency,
           debit_account_id, credit_account_id, category_id,
           frequency, "interval", start_date, end_date, next_due_date,
           is_active, created_at
    from recurring_transactions
    where organization_id = ${orgId}
      and is_active = true
      and next_due_date <= ${today}::date
      and (end_date is null or end_date >= ${today}::date)
    order by next_due_date asc
  `;
  return rows.map(mapRecurring);
}

/** 计算下一次到期日。 */
export function computeNextDueDate(
  frequency: RecurringTransactionRow['frequency'],
  interval: number,
  currentDue: string,
): string {
  const d = new Date(currentDue + 'T00:00:00');
  switch (frequency) {
    case 'daily':
      d.setDate(d.getDate() + interval);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7 * interval);
      break;
    case 'monthly':
      d.setMonth(d.getMonth() + interval);
      break;
    case 'quarterly':
      d.setMonth(d.getMonth() + 3 * interval);
      break;
    case 'yearly':
      d.setFullYear(d.getFullYear() + interval);
      break;
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
