import type { Tx } from '@/server/db/transaction';
import { findAccountByCode } from '@/server/repositories/accounts';
import { formatDateOnly } from '@/server/repositories/transactions';

/** 单页待确认条数上限。limit 来自用户输入，无上界即为廉价的资源耗尽入口（同 audit-logs.ts）。 */
export const UNCERTAIN_PAGE_MAX = 200;

export type UncertainRow = {
  id: string;
  occurredOn: string;
  description: string;
  amountMinor: bigint;
  currency: string;
};

/**
 * 找到该公司的悬置科目 id。种子科目里每家公司都有且只有一个 code = 'suspense'
 * 的科目（server/services/account-seed.ts），但停用状态不影响历史条目该不该
 * 出现在这个队列里，所以这里不检查 is_active——findAccountByCode 本来就不检查。
 */
async function findSuspenseAccountId(tx: Tx, organizationId: string): Promise<string | null> {
  const account = await findAccountByCode(tx, organizationId, 'suspense');
  return account?.id ?? null;
}

/**
 * “待确认”条目的定义：一条分录行挂在该公司的悬置科目上，且所属交易未作废。
 *
 * 不按 kind = 'journal' 判断——手工日记账（components/transaction/journal-form.tsx）
 * 也是 kind = 'journal'，但可以在任意两个科目之间过账，未必碰悬置科目；
 * 反过来，只要一笔交易真的挂在悬置科目上，不管是通过「不确定」场景卡片
 * 还是手工日记账录入的，用户都还没有为它选定分类，理应出现在这里。
 *
 * 每笔交易在悬置科目上最多一行：createJournal 要求借贷科目不同
 * （server/actions/transactions.ts），一家公司只有一个悬置科目，所以借贷
 * 两行不可能同时都是它——下面的 join 不会因为同一笔交易被数出两行。
 */
export async function countUncertain(tx: Tx, organizationId: string): Promise<number> {
  const suspenseId = await findSuspenseAccountId(tx, organizationId);
  if (!suspenseId) return 0;

  const [row] = await tx`
    select count(*)::int as n
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    where l.organization_id = ${organizationId}
      and l.account_id = ${suspenseId}
      and t.voided_at is null
  `;
  return Number(row.n);
}

/**
 * 分页列出待确认条目，按日期倒序（最新的排最前）。
 *
 * limit/offset 校验与封顶的约定照抄 server/repositories/audit-logs.ts 的
 * listAuditLogs：非法值直接抛错，超出上限的 limit 静默封顶而不是报错——
 * 调用方多半是分页控件算出来的页码，不该因为一次意外的大 limit 就整页报错。
 */
export async function listUncertain(
  tx: Tx,
  organizationId: string,
  limit?: number,
  offset?: number,
): Promise<UncertainRow[]> {
  const requestedLimit = limit ?? UNCERTAIN_PAGE_MAX;
  const requestedOffset = offset ?? 0;

  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error(
      `listUncertain requires a positive integer limit, received ${requestedLimit}.`,
    );
  }
  if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
    throw new Error(
      `listUncertain requires a non-negative integer offset, received ${requestedOffset}.`,
    );
  }

  const cappedLimit = Math.min(requestedLimit, UNCERTAIN_PAGE_MAX);

  const suspenseId = await findSuspenseAccountId(tx, organizationId);
  if (!suspenseId) return [];

  const rows = await tx`
    select t.id, t.occurred_on, t.description, t.amount_minor, t.currency
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    where l.organization_id = ${organizationId}
      and l.account_id = ${suspenseId}
      and t.voided_at is null
    order by t.occurred_on desc, t.created_at desc, t.id desc
    limit ${cappedLimit} offset ${requestedOffset}
  `;

  return rows.map((row) => ({
    id: row.id as string,
    occurredOn: formatDateOnly(row.occurred_on as Date | string),
    description: row.description as string,
    amountMinor: BigInt(row.amount_minor as string),
    currency: row.currency as string,
  }));
}
