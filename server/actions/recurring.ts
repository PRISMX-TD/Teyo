'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission, type OrgContext } from '@/server/auth/guard';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { currencyExponent, MoneyError, parseDecimalToMinor } from '@/server/domain/money';
import { postJournal } from '@/server/posting/post-journal';
import {
  getDueRecurring,
  insertRecurring,
  updateRecurring,
  setRecurringActive,
  computeNextDueDate,
} from '@/server/repositories/recurring';
import { recordAudit } from '@/server/repositories/audit-logs';
import { LedgerError, type TransactionKind } from '@/server/domain/ledger';
import { PeriodLockedError } from '@/server/domain/period-lock';
import type { PostingEvent } from '@/server/domain/posting-templates';
import type { RecurringTransactionRow } from '@/server/repositories/recurring';

export async function createRecurring(
  orgSlug: string,
  input: {
    kind: TransactionKind;
    description: string;
    amount: string;
    currency: string;
    debitAccountId: string;
    creditAccountId: string;
    // categories.category_id 在 recurring_transactions 上没有 not null 约束
    // （见 0008 迁移），insertRecurring 的形参类型也是 `string | null`——
    // 定期规则本就允许不挂分类。这里之前错标成必填，被 settings/recurring/page.tsx
    // 那个 `as unknown as` 挡住没被 tsc 发现；组件从来就只在选了值时才传。
    categoryId?: string;
    frequency: RecurringTransactionRow['frequency'];
    interval: number;
    startDate: string;
    endDate?: string;
  },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  // 验证 amount 是正的小数。小数位数由币种决定，不是永远两位——
  // 硬写 2 会让「JPY 1200」这种零小数位币种的合法金额被判成非法，
  // 也会放行一个 JPY 永远不该有的小数部分。
  parseDecimalToMinor(input.amount, currencyExponent(input.currency));

  const result = await withTransaction(context.userId, async (tx) => {
    const { id } = await insertRecurring(tx, {
      organizationId: context.organizationId,
      kind: input.kind,
      description: input.description?.trim() || null,
      amount: input.amount,
      currency: input.currency,
      debitAccountId: input.debitAccountId,
      creditAccountId: input.creditAccountId,
      categoryId: input.categoryId || null,
      frequency: input.frequency,
      interval: input.interval,
      startDate: input.startDate,
      endDate: input.endDate || null,
      nextDueDate: input.startDate,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'recurring.created',
      entityType: 'recurring_transaction',
      entityId: id,
      after: {
        kind: input.kind,
        description: input.description,
        amount: input.amount,
        frequency: input.frequency,
      },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/settings/recurring`);
  return result;
}

export async function editRecurring(
  orgSlug: string,
  id: string,
  fields: {
    description?: string;
    amount?: string;
    currency?: string;
    debitAccountId?: string;
    creditAccountId?: string;
    categoryId?: string;
    frequency?: RecurringTransactionRow['frequency'];
    interval?: number;
    startDate?: string;
    endDate?: string | null;
  },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  if (fields.amount) {
    parseDecimalToMinor(fields.amount, 2);
  }

  await withTransaction(context.userId, async (tx) => {
    await updateRecurring(tx, context.organizationId, id, {
      ...fields,
      description: fields.description?.trim() ?? undefined,
    });
  });

  revalidatePath(`/${orgSlug}/settings/recurring`);
}

export async function toggleRecurring(
  orgSlug: string,
  id: string,
  active: boolean,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  await withTransaction(context.userId, async (tx) => {
    await setRecurringActive(tx, context.organizationId, id, active);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: active ? 'recurring.activated' : 'recurring.deactivated',
      entityType: 'recurring_transaction',
      entityId: id,
      after: { isActive: active },
    });
  });

  revalidatePath(`/${orgSlug}/settings/recurring`);
}

/** 一次生成运行的结果。够界面把「都记上了」和「有几条没记上」区分开。 */
export type RecurringRunReport = {
  /** 实际入账的交易笔数——是笔数不是规则条数，一条逾期三期的规则算三笔。 */
  generated: number;
  /** 一笔都没能生成的规则，附一句用户读得懂的原因。 */
  blocked: { id: string; description: string; reason: string }[];
  /** 撞到单次补记上限、这次没补完的规则。resumeFrom 是下次从哪一期接着补。 */
  deferred: { id: string; description: string; resumeFrom: string }[];
};

/**
 * 单次运行里，单条规则最多补记多少期。
 *
 * 必须有上限：一条每日规则三年没跑过，一次就是一千多笔交易、两千多行分录
 * 挤进同一个事务，锁与内存都不好看。
 *
 * 取 60，因为它覆盖了除「每日」外每种频率的任何现实积压——60 期是 5 年的
 * 每月、超过 1 年的每周、15 年的每季、60 年的每年。只有每日规则可能撞到它，
 * 而一条每日规则积压满 60 天，本身就是该让用户看见的状态，所以撞上限的规则
 * 会进 deferred 而不是被静默截断。next_due_date 每次都推进到已入账的下一期，
 * 下一次运行接着补，一笔都不会丢。
 */
const MAX_CATCH_UP_PER_RULE = 60;

/**
 * 把一条定期规则翻译成 PostingEvent。
 *
 * 规则表存的是 debit_account_id / credit_account_id 两个字面的方向，而
 * PostingEvent 的四个变体各用不同字段名表达同一对方向。翻译的唯一规则是：
 * templateFor 放在借方的那个字段收 debitAccountId，放在贷方的那个字段收
 * creditAccountId（见 posting-templates.ts 的 accountPair）。照这条规则展开：
 *
 *   income   借 moneyAccountId   / 贷 revenueAccountId
 *   expense  借 expenseAccountId / 贷 moneyAccountId
 *   transfer 借 toAccountId      / 贷 fromAccountId
 *   journal  借 debitAccountId   / 贷 creditAccountId
 *
 * transfer 那一行最容易写反：to 才是借方，from 是贷方。写反不会报任何错——
 * 一借一贷照样配平，账户归属校验照样通过，只是每一笔转账的方向都是反的。
 */
function toPostingEvent(rule: RecurringTransactionRow, amountMinor: bigint): PostingEvent {
  switch (rule.kind) {
    case 'income':
      return {
        type: 'income',
        moneyAccountId: rule.debitAccountId,
        revenueAccountId: rule.creditAccountId,
        amountMinor,
      };
    case 'expense':
      return {
        type: 'expense',
        expenseAccountId: rule.debitAccountId,
        moneyAccountId: rule.creditAccountId,
        amountMinor,
      };
    case 'transfer':
      return {
        type: 'transfer',
        toAccountId: rule.debitAccountId,
        fromAccountId: rule.creditAccountId,
        amountMinor,
      };
    case 'journal':
      return {
        type: 'journal',
        debitAccountId: rule.debitAccountId,
        creditAccountId: rule.creditAccountId,
        amountMinor,
      };
  }
}

/**
 * 一条规则失败时，界面上写在它旁边的那句话。
 *
 * LedgerError / MoneyError / PeriodLockedError 的文案本来就是写给用户看的
 * 完整句子（「没有 EUR 到 MYR 在 2026-03-01 的汇率」这种），原样透出即可。
 * 其余是意料之外的错误：原始的 Postgres 报错对一个不懂会计的用户毫无意义，
 * 不该贴进界面，但也不能就此蒸发——落一条服务端日志，界面上换成一句
 * 说明「这条没记上、也没记一半」的话。
 */
function describeFailure(error: unknown): string {
  if (
    error instanceof LedgerError ||
    error instanceof MoneyError ||
    error instanceof PeriodLockedError
  ) {
    return error.message;
  }

  console.error('[recurring] rule generation failed', error);
  return 'Something went wrong with this rule. Nothing was recorded for it.';
}

type RuleOutcome = { posted: number; resumeFrom: string | null };

/**
 * 补记一条规则欠下的全部分录。
 *
 * 每一期都记在它自己的到期日上，而不是今天——七月的房租必须落在七月，
 * 记成今天就进了八月的损益表，而这正是用户第二天要拿去看的那张表。
 */
async function catchUpRule(
  sp: Tx,
  context: OrgContext,
  rule: RecurringTransactionRow,
  today: string,
): Promise<RuleOutcome> {
  const amountMinor = parseDecimalToMinor(rule.amount, currencyExponent(rule.currency));

  // 先把要补的到期日一次列出来，再逐笔入账：循环结束后 cursor 正好停在
  // 下一个尚未入账的到期日，无论这次是补完了还是撞了上限，它都是要写回
  // next_due_date 的那个值。
  const dueDates: string[] = [];
  let cursor = rule.nextDueDate;

  while (
    cursor <= today &&
    (rule.endDate === null || cursor <= rule.endDate) &&
    dueDates.length < MAX_CATCH_UP_PER_RULE
  ) {
    dueDates.push(cursor);
    cursor = computeNextDueDate(rule.frequency, rule.interval, cursor);
  }

  for (const occurredOn of dueDates) {
    await postJournal(sp, context, {
      event: toPostingEvent(rule, amountMinor),
      occurredOn,
      description: rule.description ?? '',
      currency: rule.currency,
      categoryId: rule.categoryId,
      // 每一期各自一个 clientUuid。共用一个的话，postJournal 的幂等查询会
      // 把第二期起全部短路掉，一条逾期三期的规则最后只入账一笔。
      clientUuid: crypto.randomUUID(),
      sourceType: 'recurring_transaction',
      sourceId: rule.id,
    });
  }

  await updateRecurring(sp, context.organizationId, rule.id, { nextDueDate: cursor });

  // 只有「撞了上限而且后面确实还欠着」才算延后。刚好补满 60 期就结束的规则
  // 是补完了，不该报告成还有积压。
  const stoppedAtCap =
    dueDates.length === MAX_CATCH_UP_PER_RULE &&
    cursor <= today &&
    (rule.endDate === null || cursor <= rule.endDate);

  return { posted: dueDates.length, resumeFrom: stoppedAtCap ? cursor : null };
}

/**
 * 生成所有到期的定期分录。
 *
 * 每条规则各自一个保存点。整批规则跑在同一个 withTransaction 里，没有保存点
 * 时任何一条抛错都会连坐整批——Task 4 给 templateFor 加了借贷不同科目的断言
 * 之后这一点变得更尖锐：一条历史遗留的、借贷填成同一个科目的规则，以前会
 * 记一笔毫无意义的对冲分录，现在会抛错，并把当天所有其它规则一起拖下水。
 *
 * 这里不能用裸 try/catch 代替保存点。一条 SQL 语句在 Postgres 里失败之后，
 * 整个事务就进入 aborted 状态，后续任何语句都只会回
 * 「current transaction is aborted」——JS 把异常接住了也没用，回滚边界必须
 * 是数据库认得的那一个，也就是 savepoint / rollback to savepoint。
 */
export async function generateDueRecurring(orgSlug: string): Promise<RecurringRunReport> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const result = await withTransaction(context.userId, async (tx) => {
    const today = new Date().toISOString().slice(0, 10);
    const dueList = await getDueRecurring(tx, context.organizationId, today);

    const report: RecurringRunReport = { generated: 0, blocked: [], deferred: [] };

    for (const rule of dueList) {
      // 界面上认规则靠这个名字。没写备注的规则退回 kind，总比一串 uuid 强。
      const label = rule.description?.trim() || rule.kind;

      try {
        const outcome = await tx.savepoint((sp) => catchUpRule(sp, context, rule, today));

        report.generated += outcome.posted;
        if (outcome.resumeFrom !== null) {
          report.deferred.push({ id: rule.id, description: label, resumeFrom: outcome.resumeFrom });
        }
      } catch (error) {
        // 这条规则的分录连同它的 next_due_date 推进一起回滚了，下次运行会
        // 从原来那一期重来。其余规则不受影响。
        report.blocked.push({ id: rule.id, description: label, reason: describeFailure(error) });
      }
    }

    return report;
  });

  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/settings/recurring`);
  return result;
}
