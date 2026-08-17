'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission } from '@/server/auth/guard';
import { LedgerError, type TransactionKind } from '@/server/domain/ledger';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import type { PostingEvent } from '@/server/domain/posting-templates';
import { assertPeriodOpen } from '@/server/domain/period-lock';
import { canEditTransaction } from '@/server/domain/permissions';
import { findAccount, getMoneyAccount } from '@/server/repositories/accounts';
import { getCategoryWithAccount } from '@/server/repositories/categories';
import { recordAudit } from '@/server/repositories/audit-logs';
import { AuthError } from '@/server/auth/guard';
import {
  findTransactionByClientUuid,
  getTransactionDetail,
  markVoided,
} from '@/server/repositories/transactions';
import { postJournal, repostJournal } from '@/server/posting/post-journal';

export type CreateTransactionInput = {
  kind: TransactionKind;
  occurredOn: string;
  amount: string;
  currency: string;
  moneyAccountId: string;
  counterAccountId?: string;
  categoryId?: string;
  description?: string;
  exchangeRate?: string;
  clientUuid: string;
};

/**
 * 解析出这笔交易的对方科目。
 *
 * 转账的对方是另一个资金账户；收支的对方是分类背后的记账科目。
 * 两条分支都必须重新按公司维度查库校验，不能相信客户端传来的 id。
 */
async function resolveCounterAccountId(
  tx: Tx,
  organizationId: string,
  input: {
    kind: TransactionKind;
    moneyAccountId: string;
    counterAccountId?: string;
    categoryId?: string;
  },
): Promise<string> {
  if (input.kind === 'journal') {
    // Journal entries use two arbitrary accounts, no category needed.
    // This function shouldn't be called for journal - the caller should handle it.
    throw new LedgerError('Journal entries do not use categories.');
  }

  if (input.kind === 'transfer') {
    if (!input.counterAccountId) {
      // counterAccountId 是转出方（表单标签 t.transaction.sourceAccount，
      // 「从哪个账户转出」）；转入方是 moneyAccountId，前面已经查过了。
      throw new LedgerError('A transfer needs a source account.');
    }
    const counter = await getMoneyAccount(tx, organizationId, input.counterAccountId);
    // 转账两端必须是不同账户。templateFor 里有同一条断言兜底，这一层留着
    // 是因为它更早触发、且此时还知道是哪个字段填错了。
    if (counter.id === input.moneyAccountId) {
      throw new LedgerError('This operation requires two different accounts.');
    }
    return counter.id;
  }

  if (!input.categoryId) {
    throw new LedgerError('Income and expense records need a category.');
  }

  const category = await getCategoryWithAccount(tx, organizationId, input.categoryId, input.kind);
  return category.accountId;
}

/**
 * 把「资金账户 + 对方科目」这套用户视角的说法翻译成 PostingEvent。
 *
 * 收入的对方是收入科目，支出的对方是费用科目。
 *
 * 转账这一对是反的，务必看清：表单里 moneyAccountId 那个选择器的标签是
 * transaction.destinationAccount，counterAccountId 的标签是
 * sourceAccount（见 transaction-form.tsx 的 transfer 分支）——资金账户是
 * 转入方，对方科目才是转出方。所以这里必须映射成
 * toAccountId = moneyAccountId / fromAccountId = counterAccountId，而
 * templateFor 的 transfer 分支再把 toAccountId 记借方、fromAccountId 记贷方
 * （见 server/domain/posting-templates.ts 的 accountPair——那是记账方向的
 * 唯一定义）。掉个个儿的分录照样配平，看板上的总额也一分不差。
 */
function toPostingEvent(
  kind: TransactionKind,
  moneyAccountId: string,
  counterAccountId: string,
  amountMinor: bigint,
): PostingEvent {
  switch (kind) {
    case 'income':
      return { type: 'income', moneyAccountId, revenueAccountId: counterAccountId, amountMinor };
    case 'expense':
      return { type: 'expense', moneyAccountId, expenseAccountId: counterAccountId, amountMinor };
    case 'transfer':
      return {
        type: 'transfer',
        fromAccountId: counterAccountId, // 转出方
        toAccountId: moneyAccountId, // 转入方
        amountMinor,
      };
    case 'journal':
      // 到不了：resolveCounterAccountId 对 journal 先抛错。createJournal 自己
      // 组装 journal 事件，不经过这里。
      throw new LedgerError('Journal entries do not use categories.');
  }
}

/**
 * 创建一笔交易：金额解析、汇率、分录生成、期间锁定与审计，全部在一个事务内完成。
 *
 * 幂等：同一 client_uuid 重复提交不报错，直接返回已有记录并置 deduplicated=true，
 * 这样 PWA 的离线重试队列不会造成重复账目。
 */
export async function createTransaction(
  orgSlug: string,
  input: CreateTransactionInput,
): Promise<{ id: string; deduplicated: boolean }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  // 期间锁定在进事务前先判，省掉一次注定要回滚的写入。
  assertPeriodOpen(input.occurredOn, context.lockedUntil, context.role);

  const result = await withTransaction(context.userId, async (tx) => {
    // 幂等短路留在解析入参之前，而不是全部交给 postJournal 的第 2 步：
    // 离线队列重放的是几分钟前就已入账成功的那一笔，若期间分类被停用或
    // 删除，先解析入参会让这次重放报错——用户看到的是一条明明成功过的
    // 记录突然失败。postJournal 里的那次查询仍在，是结构性兜底。
    const existing = await findTransactionByClientUuid(tx, context.organizationId, input.clientUuid);
    if (existing) {
      return { id: existing.id, deduplicated: true };
    }

    const moneyAccount = await getMoneyAccount(tx, context.organizationId, input.moneyAccountId);
    const counterAccountId = await resolveCounterAccountId(tx, context.organizationId, {
      kind: input.kind,
      moneyAccountId: moneyAccount.id,
      counterAccountId: input.counterAccountId,
      categoryId: input.categoryId,
    });

    const amountMinor = parseDecimalToMinor(input.amount, currencyExponent(input.currency));

    const posted = await postJournal(tx, context, {
      event: toPostingEvent(input.kind, moneyAccount.id, counterAccountId, amountMinor),
      occurredOn: input.occurredOn,
      description: input.description ?? '',
      currency: input.currency,
      manualRate: input.exchangeRate,
      // 交易表单上就有 RateField，查不到缓存汇率时让用户当场填一个。
      manualRateEntry: 'available',
      categoryId: input.categoryId ?? null,
      clientUuid: input.clientUuid,
    });

    return { id: posted.transactionId, deduplicated: posted.deduplicated };
  });

  revalidatePath(`/${orgSlug}/transactions`);
  return result;
}

export type CreateJournalInput = {
  occurredOn: string;
  amount: string;
  currency?: string;
  debitAccountId: string;
  creditAccountId: string;
  description?: string;
  clientUuid: string;
};

/**
 * 通用记账凭证：任意两个科目之间的借贷分录。
 *
 * 不限制一方必须是资金账户——用户可以把任何科目配成一对：
 *   现金 → 无形资产（资本化研发投入）
 *   预付费用 → 现金（预付一年租金）
 *   折旧 → 累计折旧（非现金的折旧分录）
 *
 * 与 createTransaction 一样享有幂等保护。
 *
 * currency 可省，省略即本位币，此时 resolveRate 不查表直接返回 1。真的传了
 * 外币，就跟别的写入点走同一条路：查缓存汇率，查不到即报错。以前这里是
 * 硬写 scaledRate = RATE_SCALE、rateSource = 'auto'，等于把一笔外币凭证按
 * 编造出来的 1:1 记进账，事后从数据里也看不出来。
 */
export async function createJournal(
  orgSlug: string,
  input: CreateJournalInput,
): Promise<{ id: string; deduplicated: boolean }> {
  const context = await requirePermission(orgSlug, 'transaction:create');
  assertPeriodOpen(input.occurredOn, context.lockedUntil, context.role);

  const clientUuid = input.clientUuid;
  const baseCurrency = context.baseCurrency;

  const result = await withTransaction(context.userId, async (tx) => {
    // 与 createTransaction 同理：幂等短路排在解析科目之前，重放不该因为
    // 某个科目事后被停用而报错。postJournal 里的那次查询是结构性兜底。
    const existing = await findTransactionByClientUuid(tx, context.organizationId, clientUuid);
    if (existing) {
      return { id: existing.id, deduplicated: true };
    }

    const debitAccount = await findAccount(tx, context.organizationId, input.debitAccountId);
    if (!debitAccount) throw new LedgerError('The debit account was not found.');
    if (!debitAccount.isActive) throw new LedgerError(`Account ${debitAccount.code} is archived.`);

    const creditAccount = await findAccount(tx, context.organizationId, input.creditAccountId);
    if (!creditAccount) throw new LedgerError('The credit account was not found.');
    if (!creditAccount.isActive) throw new LedgerError(`Account ${creditAccount.code} is archived.`);

    if (input.debitAccountId === input.creditAccountId) {
      throw new LedgerError('Debit and credit must be different accounts.');
    }

    const currency = input.currency ?? baseCurrency;
    const amountMinor = parseDecimalToMinor(input.amount, currencyExponent(currency));

    const posted = await postJournal(tx, context, {
      event: {
        type: 'journal',
        debitAccountId: debitAccount.id,
        creditAccountId: creditAccount.id,
        amountMinor,
      },
      occurredOn: input.occurredOn,
      description: input.description ?? '',
      currency,
      // 手工凭证没有汇率输入框：CreateJournalInput 里根本没有 exchangeRate，
      // journal-form.tsx 与 transaction-form.tsx 的 not-sure 分支都硬传本位币。
      manualRateEntry: 'unavailable',
      categoryId: null,
      clientUuid,
    });

    return { id: posted.transactionId, deduplicated: posted.deduplicated };
  });

  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/reports`);
  return result;
}

export type UpdateTransactionInput = {
  occurredOn: string;
  amount: string;
  currency: string;
  moneyAccountId: string;
  counterAccountId?: string;
  categoryId?: string;
  description?: string;
  exchangeRate?: string;
};

/**
 * 编辑一笔交易。
 *
 * 只要 transaction:read 就能进来，真正的授权靠 canEditTransaction：
 * bookkeeper 只能改自己录的，owner/admin 可以改任何人的。用
 * transaction:create 做门槛是不对的——viewer 与 bookkeeper 的区别不在能否
 * 创建，而在能否改哪些记录。
 *
 * 这里只做入参解析与授权：作废判定、canEditTransaction、kind 不可改、
 * 资金账户与对方科目的公司维度校验。期间检查、汇率决策、分录重建与审计
 * 全在 repostJournal 里——包括「未改币种与日期时复用既有汇率」那条规则，
 * 它必须由边界依据 existing 行自己判断，而不是由调用方算好汇率传进去。
 */
export async function updateTransaction(
  orgSlug: string,
  id: string,
  input: UpdateTransactionInput,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  await withTransaction(context.userId, async (tx) => {
    const existing = await getTransactionDetail(tx, context.organizationId, id);

    if (existing.voidedAt) {
      throw new AuthError('forbidden', 'This record is voided and can no longer be edited.');
    }

    if (!canEditTransaction(context.role, existing.createdBy === context.userId)) {
      throw new AuthError('forbidden', 'Your role cannot edit this record.');
    }

    // kind 不可改：改了就等于换一笔账，分录方向、分类与对方账户全都得重来，
    // 让用户作废重录更清晰，也让审计留下两条独立记录。
    const kind = existing.kind;

    const moneyAccount = await getMoneyAccount(tx, context.organizationId, input.moneyAccountId);
    const counterAccountId = await resolveCounterAccountId(tx, context.organizationId, {
      kind,
      moneyAccountId: moneyAccount.id,
      counterAccountId: input.counterAccountId,
      categoryId: input.categoryId,
    });

    const amountMinor = parseDecimalToMinor(input.amount, currencyExponent(input.currency));

    await repostJournal(tx, context, {
      transactionId: id,
      event: toPostingEvent(kind, moneyAccount.id, counterAccountId, amountMinor),
      occurredOn: input.occurredOn,
      description: input.description ?? '',
      currency: input.currency,
      manualRate: input.exchangeRate,
      // 编辑走的是同一张表单，RateField 同样在。
      manualRateEntry: 'available',
      categoryId: input.categoryId ?? null,
      existing: {
        occurredOn: existing.occurredOn,
        description: existing.description,
        currency: existing.currency,
        amountMinor: existing.amountMinor,
        baseAmountMinor: existing.baseAmountMinor,
        categoryId: existing.categoryId,
        exchangeRate: existing.exchangeRate,
        rateSource: existing.rateSource,
      },
    });
  });

  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/transactions/${id}`);
}

/**
 * 作废一笔交易。分录保留不动——账目要可追溯，删掉分录就查不出当初记了什么。
 * 数据库层也没有 delete 策略，硬删除在那一层就不可能。
 */
export async function voidTransaction(
  orgSlug: string,
  id: string,
  reason: string,
): Promise<void> {
  const cleanReason = reason.trim();
  if (cleanReason === '') {
    throw new LedgerError('Voiding a record needs a reason.');
  }

  const context = await requirePermission(orgSlug, 'transaction:read');

  await withTransaction(context.userId, async (tx) => {
    const existing = await getTransactionDetail(tx, context.organizationId, id);

    if (existing.voidedAt) {
      throw new AuthError('forbidden', 'This record is already voided.');
    }

    if (!canEditTransaction(context.role, existing.createdBy === context.userId)) {
      throw new AuthError('forbidden', 'Your role cannot void this record.');
    }

    assertPeriodOpen(existing.occurredOn, context.lockedUntil, context.role);

    await markVoided(tx, context.organizationId, id, context.userId, cleanReason);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'transaction.voided',
      entityType: 'transaction',
      entityId: id,
      before: { voidedAt: null },
      after: { voidedAt: new Date().toISOString(), voidReason: cleanReason },
    });
  });

  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/transactions/${id}`);
}
