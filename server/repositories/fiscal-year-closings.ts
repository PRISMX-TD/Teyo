import { randomUUID } from 'node:crypto';
import type { Tx } from '@/server/db/transaction';
import { toIsoDate } from '@/lib/format';

/**
 * fiscal_year_closings 的读写（见 0024 迁移）。
 *
 * 这张表回答三个问题，而它们都没法从交易表里凑出来：
 *   - 这个财年结过没有？（唯一约束 (organization_id, period_start)）
 *   - 结的是哪一笔分录？（撤销要作废它）
 *   - 结出来的净利润是多少？（界面显示，不必为一个数字重算一遍损益表）
 *
 * 表上**没有 update 策略**，所以这里也不提供更新函数：一次年结的内容在它
 * 发生的那一刻就定死了，要改只能撤销重做。
 */

export type FiscalYearClosingRow = {
  id: string;
  periodStart: string;
  periodEnd: string;
  /** 结转分录。表上是 on delete set null，所以读出来可能是 null。 */
  transactionId: string | null;
  netIncomeMinor: bigint;
  closedAt: Date;
  closedBy: string;
  closedByName: string | null;
  /** 那笔分录是否已被作废。transactionId 为 null 时恒为 false。 */
  transactionVoided: boolean;
};

/**
 * date 列由 postgres.js 解析成 Date 对象而不是字符串，直接 String() 会得到
 * `Thu Aug 06 2026 ...` 这种 JS 默认格式。复用 toIsoDate（与 reports.ts 的
 * 总账、guard.ts 的 toDateOnly 同一个坑、同一个修法）。
 */
function mapRow(row: Record<string, unknown>): FiscalYearClosingRow {
  return {
    id: row.id as string,
    periodStart: toIsoDate(row.period_start as Date | string),
    periodEnd: toIsoDate(row.period_end as Date | string),
    transactionId: (row.transaction_id as string | null) ?? null,
    netIncomeMinor: BigInt(row.net_income_minor as string),
    closedAt: row.closed_at as Date,
    closedBy: row.closed_by as string,
    closedByName: (row.closed_by_name as string | null) ?? null,
    transactionVoided: row.transaction_voided === true,
  };
}

// 四条查询各自写一遍列清单是刻意的：抽成一个字符串常量会诱使下一个人用
// tx.unsafe 去拼它，而那把一个参数化查询变成了字符串拼接。

/** 历史记录，最近的财年排在前面——界面上第一眼要看到的是最近结的那一次。 */
export async function listFiscalYearClosings(
  tx: Tx,
  organizationId: string,
): Promise<FiscalYearClosingRow[]> {
  const rows = await tx`
    select
      f.id, f.period_start, f.period_end, f.transaction_id, f.net_income_minor,
      f.closed_at, f.closed_by, u.display_name as closed_by_name,
      (t.voided_at is not null) as transaction_voided
    from fiscal_year_closings f
    left join app_users u on u.id = f.closed_by
    left join transactions t on t.id = f.transaction_id
    where f.organization_id = ${organizationId}
    order by f.period_start desc
  `;
  return rows.map((row) => mapRow(row as unknown as Record<string, unknown>));
}

/**
 * 某个财年的结转记录，没有就返回 null。
 *
 * 按 period_start 而不是按 period_end 查：唯一约束建在 (organization_id,
 * period_start) 上，按同一个键查询与去重，两处不会漂移。
 */
export async function findFiscalYearClosing(
  tx: Tx,
  organizationId: string,
  periodStart: string,
): Promise<FiscalYearClosingRow | null> {
  const rows = await tx`
    select
      f.id, f.period_start, f.period_end, f.transaction_id, f.net_income_minor,
      f.closed_at, f.closed_by, u.display_name as closed_by_name,
      (t.voided_at is not null) as transaction_voided
    from fiscal_year_closings f
    left join app_users u on u.id = f.closed_by
    left join transactions t on t.id = f.transaction_id
    where f.organization_id = ${organizationId} and f.period_start = ${periodStart}::date
  `;
  const row = rows.at(0);
  return row ? mapRow(row as unknown as Record<string, unknown>) : null;
}

/** 按 id 取一条，撤销时用（撤销的入参是登记行的 id，不是财年）。 */
export async function getFiscalYearClosingById(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<FiscalYearClosingRow | null> {
  const rows = await tx`
    select
      f.id, f.period_start, f.period_end, f.transaction_id, f.net_income_minor,
      f.closed_at, f.closed_by, u.display_name as closed_by_name,
      (t.voided_at is not null) as transaction_voided
    from fiscal_year_closings f
    left join app_users u on u.id = f.closed_by
    left join transactions t on t.id = f.transaction_id
    where f.organization_id = ${organizationId} and f.id = ${id}
  `;
  const row = rows.at(0);
  return row ? mapRow(row as unknown as Record<string, unknown>) : null;
}

/**
 * 主键在应用侧生成，刻意不用 `insert ... returning id`。
 *
 * 与 insertOrganization 同一个理由（见 server/repositories/organizations.ts）：
 * Postgres 对 RETURNING 的行会额外施加 SELECT 策略检查。这里的读策略
 * app_is_member 对 owner 当然通得过，所以 returning 其实也能用；自己生成
 * uuid 只是少一次策略求值，并且让这一批仓储的写法保持一致。
 */
export async function insertFiscalYearClosing(
  tx: Tx,
  input: {
    organizationId: string;
    periodStart: string;
    periodEnd: string;
    transactionId: string;
    netIncomeMinor: bigint;
    closedBy: string;
  },
): Promise<string> {
  const id = randomUUID();
  await tx`
    insert into fiscal_year_closings
      (id, organization_id, period_start, period_end, transaction_id, net_income_minor, closed_by)
    values (
      ${id},
      ${input.organizationId},
      ${input.periodStart}::date,
      ${input.periodEnd}::date,
      ${input.transactionId},
      ${input.netIncomeMinor.toString()},
      ${input.closedBy}
    )
  `;
  return id;
}

/**
 * 删一条登记行。这是**唯一**的撤销方式——表上没有 update 策略，一次年结
 * 要么在，要么不在。
 */
export async function deleteFiscalYearClosing(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    delete from fiscal_year_closings
    where id = ${id} and organization_id = ${organizationId}
  `;
}
