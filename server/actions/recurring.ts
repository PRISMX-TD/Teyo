'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, requirePermission, type OrgContext } from '@/server/auth/guard';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { currencyExponent, MoneyError, parseDecimalToMinor } from '@/server/domain/money';
import { postJournal } from '@/server/posting/post-journal';
import {
  getDueRecurring,
  insertRecurring,
  updateRecurring,
  setRecurringActive,
  computeNextDueDate,
  plannedDueDates,
  MAX_CATCH_UP_PER_RULE,
} from '@/server/repositories/recurring';
import { recordAudit } from '@/server/repositories/audit-logs';
import { LedgerError, type TransactionKind } from '@/server/domain/ledger';
import { PeriodLockedError } from '@/server/domain/period-lock';
import type { PostingEvent } from '@/server/domain/posting-templates';
import type { RecurringTransactionRow } from '@/server/repositories/recurring';

/**
 * 「每几期一次」必须是至少 1 的整数。
 *
 * 数据库层至今没有这条约束（interval integer not null default 1，见 0008），
 * 客户端那个 Math.max(1, ...) 只是表单上的夹取，直接调用 Server Action 就绕过去了。
 * interval = 0 时 computeNextDueDate 五个分支全是恒等函数，到期日永远不推进——
 * 补记循环会把同一天记满上限那么多笔，每笔一个新的 clientUuid，幂等也拦不住：
 * 一笔 1200 的月租会变成 72000，账面完全配平，再点一次再来 60 笔。
 * 0019 迁移会把这条约束补进库里，在那之前这里是唯一的闸门。
 */
function assertValidInterval(interval: number): void {
  if (!Number.isInteger(interval) || interval < 1) {
    throw new LedgerError('How often this repeats must be a whole number, at least 1.');
  }
}

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
  assertValidInterval(input.interval);

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

/**
 * editRecurring 能改的字段。
 *
 * amount 与 currency 是一对，类型上就绑死：要么两个都给，要么一个都不给。
 *
 * 分开可选会漏掉两种写法，而且两种的终局是一样的——规则永远生成不出来。
 * 金额该有几位小数只由币种决定：
 *   只给 amount —— 拿不到库里的币种，就只能按 2 位「大概验一下」，于是
 *     合法的「JPY 500」被拒，非法的「JPY 500.50」被放行。
 *   只给 currency —— 校验根本不会触发，可 updateRecurring 照样把币种写进去，
 *     一条存着 '500.00' 的规则就此变成 JPY 规则。catchUpRule 之后按
 *     exponent 0 解析这个金额，每次运行都失败，而用户能编辑的任何单个字段
 *     都救不回来。
 *
 * 类型挡的是「这种调用写不出来」，函数里那道运行时检查挡的是「Server Action
 * 的入参来自网络，类型在运行时已经不存在了」。两道都要。
 */
export type RecurringEditFields = {
  description?: string;
  debitAccountId?: string;
  creditAccountId?: string;
  categoryId?: string;
  frequency?: RecurringTransactionRow['frequency'];
  interval?: number;
  startDate?: string;
  endDate?: string | null;
} & (
  | { amount: string; currency: string }
  | { amount?: undefined; currency?: undefined }
);

export async function editRecurring(
  orgSlug: string,
  id: string,
  fields: RecurringEditFields,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  if (fields.amount !== undefined && fields.currency !== undefined) {
    parseDecimalToMinor(fields.amount, currencyExponent(fields.currency));
  } else if (fields.amount !== undefined || fields.currency !== undefined) {
    // 类型已经排除了这种调用，能走到这里说明入参不是 TypeScript 写出来的
    // ——Server Action 收的是网络上的任意 payload。
    throw new LedgerError(
      'Change the amount and the currency together, so the number of decimals can be checked.',
    );
  }

  if (fields.interval !== undefined) {
    assertValidInterval(fields.interval);
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
  /**
   * 卡住的规则，附一句用户读得懂的原因。
   *
   * occurredOn 是卡在哪一期。补记会逐期入账，所以一条规则可能已经记好了前
   * 几期、停在第四期——那一期的日期就是用户要去处理的地方（比如补一条那天
   * 的汇率）。整条规则在开始之前就失败时（金额解析不了、重复间隔是 0），
   * 没有哪一期可指，为 null。
   */
  blocked: { id: string; description: string; occurredOn: string | null; reason: string }[];
  /** 撞到单次补记上限、这次没补完的规则。resumeFrom 是下次从哪一期接着补。 */
  deferred: { id: string; description: string; resumeFrom: string }[];
};

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

type RuleOutcome = {
  posted: number;
  resumeFrom: string | null;
  failure: { occurredOn: string; reason: string } | null;
};

/**
 * 补记一条规则欠下的全部分录。
 *
 * 每一期都记在它自己的到期日上，而不是今天——七月的房租必须落在七月，
 * 记成今天就进了八月的损益表，而这正是用户第二天要拿去看的那张表。
 *
 * 每一期各自再套一层保存点，这一层不能省。整条规则共用一个保存点时，中间
 * 任何一期失败都会把已经记好的前几期一起回滚，next_due_date 也退回原处，
 * 于是下一次运行从同一期重来、同样失败——那条规则从此再也生成不出任何东西。
 * 而「某一期缺汇率」恰恰是最常见的情况：findRate 只回溯 7 天，Cron 又只同步
 * 「今天」，任何在规则起始日之后才开始用这个应用的公司，历史汇率本来就是空的。
 * 结果就是几个月的外币支出从损益表上整片消失——正是这个任务要根除的失败模式。
 *
 * 改成逐期保存点后：失败之前记好的都留下，cursor 停在失败的那一期，规则被
 * 报告成 blocked 并带上那个日期。用户看到的是「2026-03-01 这天没有汇率」，
 * 而不是一条什么都不生成、也什么都不说的规则。
 */
async function catchUpRule(
  sp: Tx,
  context: OrgContext,
  rule: RecurringTransactionRow,
  today: string,
): Promise<RuleOutcome> {
  const amountMinor = parseDecimalToMinor(rule.amount, currencyExponent(rule.currency));
  const dueDates = plannedDueDates(rule, today);

  // 补完全部时，cursor 落在最后一期之后的下一期；中途失败时，落在失败的那一期。
  let cursor =
    dueDates.length === 0
      ? rule.nextDueDate
      : computeNextDueDate(rule.frequency, rule.interval, dueDates[dueDates.length - 1]);

  let posted = 0;
  let failure: { occurredOn: string; reason: string } | null = null;

  for (const occurredOn of dueDates) {
    try {
      await sp.savepoint((occurrence) =>
        postJournal(occurrence, context, {
          event: toPostingEvent(rule, amountMinor),
          occurredOn,
          description: rule.description ?? '',
          currency: rule.currency,
          // 定期规则没有汇率：recurring_transactions 里没有这一列，界面上
          // 也没有这一栏。补记历史月份的外币规则最常撞上「查不到汇率」
          // （findRate 只回溯 7 天，cron 只同步今天），而这个入口给不了
          // 用户任何可以填汇率的地方。
          manualRateEntry: 'unavailable',
          categoryId: rule.categoryId,
          // 每一期各自一个 clientUuid。共用一个的话，postJournal 的幂等查询会
          // 把第二期起全部短路掉，一条逾期三期的规则最后只入账一笔。
          clientUuid: crypto.randomUUID(),
          sourceType: 'recurring_transaction',
          sourceId: rule.id,
        }),
      );
      posted += 1;
    } catch (error) {
      // 停在这一期。后面的期数不试了——它们多半会因为同样的原因失败，而且
      // 跳过这一期继续往后记会让账目出现一个无声的窟窿。
      failure = { occurredOn, reason: describeFailure(error) };
      cursor = occurredOn;
      break;
    }
  }

  await updateRecurring(sp, context.organizationId, rule.id, { nextDueDate: cursor });

  // 只有「补满了上限、没出错、而且后面确实还欠着」才算延后。刚好补满 60 期
  // 就结束的规则是补完了，不该报告成还有积压。
  const stoppedAtCap =
    failure === null &&
    dueDates.length === MAX_CATCH_UP_PER_RULE &&
    cursor <= today &&
    (rule.endDate === null || cursor <= rule.endDate);

  return { posted, resumeFrom: stoppedAtCap ? cursor : null, failure };
}

/**
 * 生成所有到期的定期分录。
 *
 * 保存点分两层，各挡一种连坐：
 *
 *   规则一层（这里）——整批规则跑在同一个 withTransaction 里，没有保存点时
 *   任何一条抛错都会连坐整批。Task 4 给 templateFor 加了借贷不同科目的断言
 *   之后这一点变得更尖锐：一条历史遗留的、借贷填成同一个科目的规则，以前会
 *   记一笔毫无意义的对冲分录，现在会抛错，并把当天所有其它规则一起拖下水。
 *
 *   期数一层（catchUpRule 里）——一条规则内部某一期失败，不该把这条规则已经
 *   补好的前几期一起回滚。理由见那个函数的注释。
 *
 * 两层都不能用裸 try/catch 代替。一条 SQL 语句在 Postgres 里失败之后，整个
 * 事务就进入 aborted 状态，后续任何语句都只会回「current transaction is
 * aborted」——JS 把异常接住了也没用，回滚边界必须是数据库认得的那一个，
 * 也就是 savepoint / rollback to savepoint。
 */
export async function generateDueRecurring(orgSlug: string): Promise<RecurringRunReport> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  // 先判角色，再开事务。
  //
  // 这个动作的门槛是 transaction:create，bookkeeper 有；但 recurring_transactions
  // 的 RLS 写入策略要求 owner 或 admin（0010_fix_rls_pattern.sql 的 with check）。
  // for update 只需要 using 子句，所以 bookkeeper 读得到也锁得住规则，偏偏在每条
  // 规则末尾那句推进 next_due_date 的 UPDATE 上被 RLS 拒绝——那是个原始的
  // Postgres 错误，不是 LedgerError，于是每条规则都换回一句「出了点问题」，
  // 用户连着看到 N 句一模一样、什么也没说的话。
  //
  // 权限矩阵与 RLS 对不上本身是既有问题（后续阶段会把两者统一到一处定义），
  // 这里不修它，只保证它说人话：一次说清，并指明该找谁。
  if (context.role !== 'owner' && context.role !== 'admin') {
    throw new AuthError(
      'forbidden',
      'Only an owner or an admin can run recurring entries. Ask one of them to run this for you.',
    );
  }

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

        if (outcome.failure !== null) {
          // 中途卡住：卡住之前记好的那几期留在账上，cursor 停在失败的那一期。
          report.blocked.push({
            id: rule.id,
            description: label,
            occurredOn: outcome.failure.occurredOn,
            reason: outcome.failure.reason,
          });
        } else if (outcome.resumeFrom !== null) {
          report.deferred.push({ id: rule.id, description: label, resumeFrom: outcome.resumeFrom });
        }
      } catch (error) {
        // 整条规则在开始之前就失败了（金额解析不了、重复间隔是 0、或者最后
        // 那句推进 next_due_date 被拒），保存点把这条规则做过的一切都回滚了，
        // 下次运行从原来那一期重来。其余规则不受影响。
        report.blocked.push({
          id: rule.id,
          description: label,
          occurredOn: null,
          reason: describeFailure(error),
        });
      }
    }

    return report;
  });

  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/settings/recurring`);
  return result;
}
