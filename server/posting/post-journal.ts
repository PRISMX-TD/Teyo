import type { Tx } from '@/server/db/transaction';
import type { OrgContext } from '@/server/auth/guard';
import { assertPeriodOpen } from '@/server/domain/period-lock';
import { assertLineInvariants, buildLines } from '@/server/domain/ledger';
import { templateFor, type PostingEvent } from '@/server/domain/posting-templates';
import { resolveRate } from '@/server/posting/rate';
import { recordAudit } from '@/server/repositories/audit-logs';
import { findTransactionByClientUuid } from '@/server/repositories/transactions';
import { insertJournalLines, insertTransaction } from '@/server/posting/insert';

export type PostJournalInput = {
  event: PostingEvent;
  occurredOn: string; // YYYY-MM-DD
  description: string;
  currency: string;
  /** 用户手工输入的汇率；未提供时由 resolveRate 查缓存。 */
  manualRate?: string;
  categoryId: string | null;
  clientUuid: string;
  sourceType?: string | null;
  sourceId?: string | null;
};

/**
 * 记账凭证的唯一写入出口。
 *
 * 在这之前，insertTransaction/insertJournalLines 在三个地方各自被直接调用
 * （createTransaction、createJournal、generateDueRecurring、postDepreciation），
 * 行级不变量与账户归属校验是否执行，全凭每个调用方自己记得——这是约定，
 * 不是结构性保证，任何新写入点都可能漏掉。postJournal 把这十个步骤钉死
 * 成固定顺序，往后任何记账都必须经过这里。
 *
 * 内部固定顺序（不可跳步、不可重排）：
 *   1. assertPeriodOpen  —— 先判期间是否封账。
 *   2. clientUuid 幂等查询 —— 命中则直接返回，不做任何写入。
 *   3. resolveRate —— 查不到即抛错，绝不回退 1。
 *   4. templateFor(event) —— 映射成一对草稿分录。
 *   5. buildLines —— 换算本位币金额，内部已做 assertBalanced。
 *   6. assertLineInvariants —— 行级不变量，必须在任何 insert 之前。
 *   7. insertTransaction —— 写交易表头。
 *   8. insertJournalLines —— 写分录行；写入前会核实每个 accountId 属于本公司
 *      （PostgreSQL 的外键校验不受 RLS 约束，这一步不能省，见 insert.ts）。
 *   9. recordAudit —— 与业务写入同事务，回滚时一起回滚。
 *   10. 返回 { transactionId, deduplicated: false }。
 *
 * 两处顺序尤其不能挪动：
 *
 * 幂等查询必须夹在期间检查之后、汇率解析之前。放在期间检查之前，一次
 * 重放就能绕开封账；放在汇率解析之后，一笔根本不需要再写入的重放会
 * 白白查一次汇率——汇率缓存缺失时，还会把一笔早已成功的重放变成报错，
 * 三种排序里这是最差的结果：用户看到的是一条明明成功过的记录突然失败。
 *
 * assertBalanced（buildLines 内部）与 assertLineInvariants 必须都在任何
 * insert 之前跑完，而不是先插入部分行、指望 withTransaction 的回滚去
 * 撤销。回滚确实能保证数据库最终状态正确，但那是「出错后清理」，不是
 * 「从未构造出错误的行」——先validate 再 insert 才是本任务要把约定
 * 变成结构的地方。
 */
export async function postJournal(
  tx: Tx,
  ctx: OrgContext,
  input: PostJournalInput,
): Promise<{ transactionId: string; deduplicated: boolean }> {
  // 1. 期间检查——省掉一次注定要回滚的写入。
  assertPeriodOpen(input.occurredOn, ctx.lockedUntil);

  // 2. 幂等查询。命中直接返回，不碰 resolveRate，也不写任何行。
  const existing = await findTransactionByClientUuid(tx, ctx.organizationId, input.clientUuid);
  if (existing) {
    return { transactionId: existing.id, deduplicated: true };
  }

  // 3. 汇率解析——手工优先，否则查缓存；查不到就抛错，绝不回退 1。
  const { scaledRate, source: rateSource } = await resolveRate(tx, {
    currency: input.currency,
    baseCurrency: ctx.baseCurrency,
    occurredOn: input.occurredOn,
    manualRate: input.manualRate,
  });

  // 4-5. 事件 -> 草稿分录 -> 换算本位币金额（buildLines 内部已 assertBalanced）。
  const specs = templateFor(input.event);
  const lines = buildLines(specs, {
    currency: input.currency,
    baseCurrency: ctx.baseCurrency,
    scaledRate,
  });

  // 6. 行级不变量，必须在任何 insert 之前。
  assertLineInvariants(lines, {
    currency: input.currency,
    baseCurrency: ctx.baseCurrency,
    scaledRate,
    rateSource,
  });

  const kind = input.event.type;
  // 转账与手工凭证不挂分类，与 transactions_category_matches_kind 约束一致
  // （见 0014 迁移）；收支两种事件必须带分类，否则由该约束在库层拒绝。
  const categoryId = kind === 'transfer' || kind === 'journal' ? null : input.categoryId;

  // 取自分录行而非另算一遍：表头金额与分录必须同源，否则两者可能不一致，
  // 而数据库的平衡触发器只看分录、看不到表头。templateFor 的四种模板都把
  // 借方放在第一行，所以 lines[0] 就是这笔交易的本位币金额。
  const baseAmountMinor = lines[0].baseAmountMinor;

  // 7. 写交易表头。
  const { id: transactionId } = await insertTransaction(tx, {
    organizationId: ctx.organizationId,
    kind,
    occurredOn: input.occurredOn,
    description: input.description,
    currency: input.currency,
    amountMinor: input.event.amountMinor,
    baseAmountMinor,
    scaledRate,
    rateSource,
    categoryId,
    createdBy: ctx.userId,
    clientUuid: input.clientUuid,
  });

  // 8. 写分录行。insertJournalLines 内部会先核实每个 accountId 属于本公司。
  await insertJournalLines(tx, ctx.organizationId, transactionId, lines);

  // 9. 审计，与业务写入同事务。
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'transaction.created',
    entityType: 'transaction',
    entityId: transactionId,
    after: {
      kind,
      occurredOn: input.occurredOn,
      currency: input.currency,
      // bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。
      amountMinor: input.event.amountMinor.toString(),
      baseAmountMinor: baseAmountMinor.toString(),
      rateSource,
      categoryId,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      lines: lines.map((line) => ({
        accountId: line.accountId,
        direction: line.direction,
        amountMinor: line.amountMinor.toString(),
      })),
    },
  });

  // 10. 返回。
  return { transactionId, deduplicated: false };
}
