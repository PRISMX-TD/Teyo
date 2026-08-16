'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission } from '@/server/auth/guard';
import {
  assertLineInvariants,
  buildJournalLines,
  LedgerError,
  type TransactionKind,
} from '@/server/domain/ledger';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import { parseRateToScaled, RATE_SCALE } from '@/server/domain/exchange-rate';
import { assertPeriodOpen } from '@/server/domain/period-lock';
import { canEditTransaction } from '@/server/domain/permissions';
import { findAccount, getMoneyAccount } from '@/server/repositories/accounts';
import { getCategoryWithAccount } from '@/server/repositories/categories';
import { recordAudit } from '@/server/repositories/audit-logs';
import { AuthError } from '@/server/auth/guard';
import {
  deleteJournalLines,
  findTransactionByClientUuid,
  getTransactionDetail,
  markVoided,
  updateTransactionHead,
} from '@/server/repositories/transactions';
import { insertJournalLines, insertTransaction } from '@/server/posting/insert';
import { resolveRate } from '@/server/posting/rate';

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
  input: { kind: TransactionKind; counterAccountId?: string; categoryId?: string },
): Promise<string> {
  if (input.kind === 'journal') {
    // Journal entries use two arbitrary accounts, no category needed.
    // This function shouldn't be called for journal - the caller should handle it.
    throw new LedgerError('Journal entries do not use categories.');
  }

  if (input.kind === 'transfer') {
    if (!input.counterAccountId) {
      throw new LedgerError('A transfer needs a destination account.');
    }
    const counter = await getMoneyAccount(tx, organizationId, input.counterAccountId);
    return counter.id;
  }

  if (!input.categoryId) {
    throw new LedgerError('Income and expense records need a category.');
  }

  const category = await getCategoryWithAccount(tx, organizationId, input.categoryId, input.kind);
  return category.accountId;
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
  assertPeriodOpen(input.occurredOn, context.lockedUntil);

  const result = await withTransaction(context.userId, async (tx) => {
    const existing = await findTransactionByClientUuid(tx, context.organizationId, input.clientUuid);
    if (existing) {
      return { id: existing.id, deduplicated: true };
    }

    const moneyAccount = await getMoneyAccount(tx, context.organizationId, input.moneyAccountId);
    const counterAccountId = await resolveCounterAccountId(tx, context.organizationId, input);

    const amountMinor = parseDecimalToMinor(input.amount, currencyExponent(input.currency));
    const { scaledRate, source } = await resolveRate(tx, {
      currency: input.currency,
      baseCurrency: context.baseCurrency,
      occurredOn: input.occurredOn,
      manualRate: input.exchangeRate,
    });

    const lines = buildJournalLines({
      kind: input.kind,
      amountMinor,
      currency: input.currency,
      baseCurrency: context.baseCurrency,
      scaledRate,
      moneyAccountId: moneyAccount.id,
      counterAccountId,
    });

    // 取自分录行而非另算一遍：表头金额与分录必须同源，
    // 否则两者可能不一致，而数据库的平衡触发器只看分录、看不到表头。
    const baseAmountMinor = lines[0].baseAmountMinor;

    const { id } = await insertTransaction(tx, {
      organizationId: context.organizationId,
      kind: input.kind,
      occurredOn: input.occurredOn,
      description: input.description ?? '',
      currency: input.currency,
      amountMinor,
      baseAmountMinor,
      scaledRate,
      rateSource: source,
      categoryId: input.kind === 'transfer' ? null : (input.categoryId as string),
      createdBy: context.userId,
      clientUuid: input.clientUuid,
    });

    assertLineInvariants(lines, {
      currency: input.currency,
      baseCurrency: context.baseCurrency,
      scaledRate,
      rateSource: source,
    });

    await insertJournalLines(tx, context.organizationId, id, lines);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'transaction.created',
      entityType: 'transaction',
      entityId: id,
      after: {
        kind: input.kind,
        occurredOn: input.occurredOn,
        currency: input.currency,
        // bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。
        amountMinor: amountMinor.toString(),
        baseAmountMinor: baseAmountMinor.toString(),
        rateSource: source,
        categoryId: input.categoryId ?? null,
      },
    });

    return { id, deduplicated: false };
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
 * 金额用本位币，不需要汇率查表。与 createTransaction 一样享有幂等保护。
 */
export async function createJournal(
  orgSlug: string,
  input: CreateJournalInput,
): Promise<{ id: string; deduplicated: boolean }> {
  const context = await requirePermission(orgSlug, 'transaction:create');
  assertPeriodOpen(input.occurredOn, context.lockedUntil);

  const clientUuid = input.clientUuid;
  const baseCurrency = context.baseCurrency;

  const result = await withTransaction(context.userId, async (tx) => {
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

    const lines = buildJournalLines({
      kind: 'journal',
      amountMinor,
      currency,
      baseCurrency,
      scaledRate: RATE_SCALE,
      moneyAccountId: debitAccount.id,    // journal: debit
      counterAccountId: creditAccount.id,  // journal: credit
    });

    const baseAmountMinor = lines[0].baseAmountMinor;

    const { id } = await insertTransaction(tx, {
      organizationId: context.organizationId,
      kind: 'journal',
      occurredOn: input.occurredOn,
      description: input.description ?? '',
      currency,
      amountMinor,
      baseAmountMinor,
      scaledRate: RATE_SCALE,
      rateSource: 'auto',
      categoryId: null,
      createdBy: context.userId,
      clientUuid,
    });

    assertLineInvariants(lines, {
      currency,
      baseCurrency,
      scaledRate: RATE_SCALE,
      rateSource: 'auto',
    });

    await insertJournalLines(tx, context.organizationId, id, lines);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'transaction.created',
      entityType: 'transaction',
      entityId: id,
      after: {
        kind: 'journal',
        occurredOn: input.occurredOn,
        currency,
        amountMinor: amountMinor.toString(),
        baseAmountMinor: baseAmountMinor.toString(),
        debitAccount: debitAccount.code,
        creditAccount: creditAccount.code,
        description: input.description ?? '',
      },
    });

    return { id, deduplicated: false };
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
 * 分录不原地改而是整体重建。journal_lines 的平衡触发器是延迟约束，
 * 同一事务内先删后插不会中途报错，提交时才校验最终状态。
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

    // 原日期与新日期都要在开放期间内：只查其一，就能把记录搬进或搬出锁定区间。
    assertPeriodOpen(existing.occurredOn, context.lockedUntil);
    assertPeriodOpen(input.occurredOn, context.lockedUntil);

    // kind 不可改：改了就等于换一笔账，分录方向、分类与对方账户全都得重来，
    // 让用户作废重录更清晰，也让审计留下两条独立记录。
    const kind = existing.kind;

    const moneyAccount = await getMoneyAccount(tx, context.organizationId, input.moneyAccountId);
    const counterAccountId = await resolveCounterAccountId(tx, context.organizationId, {
      kind,
      counterAccountId: input.counterAccountId,
      categoryId: input.categoryId,
    });

    const amountMinor = parseDecimalToMinor(input.amount, currencyExponent(input.currency));

    // 没提交手工汇率、且币种和日期都没变时，直接沿用这笔交易当初记的汇率与
    // 来源，不再重新调用 resolveRate。RateField 在这种情况下就是这么显示
    // 的（见 rate-field.tsx 的 initialRate/initialSource）——如果这里还是
    // 每次保存都重新解析，两边就会对不上：exchange_rates 只由每天的 cron
    // upsert「今天」这一格（见 app/api/cron/exchange-rates/route.ts），
    // 所以早上记一笔外币交易时 findRate 的 7 天回溯会命中前一个营业日的
    // 汇率并存成 auto；同一天晚些时候 cron 把「今天」这一格填上后，若只是
    // 改个备注就保存，resolveRate 会重新查到当天的精确汇率，把汇率和本位
    // 币金额悄悄换成屏幕上从未展示过的另一个值。币种或日期真的变了，
    // 或者用户主动填了手工汇率，才应该重新解析——那两种情况都会让下面
    // 这个条件为 false，直接走原来的 resolveRate 分支。
    const reuseStoredRate =
      input.exchangeRate === undefined &&
      input.currency === existing.currency &&
      input.occurredOn === existing.occurredOn;

    const { scaledRate, source } = reuseStoredRate
      ? { scaledRate: parseRateToScaled(existing.exchangeRate), source: existing.rateSource }
      : await resolveRate(tx, {
          currency: input.currency,
          baseCurrency: context.baseCurrency,
          occurredOn: input.occurredOn,
          manualRate: input.exchangeRate,
        });

    const lines = buildJournalLines({
      kind,
      amountMinor,
      currency: input.currency,
      baseCurrency: context.baseCurrency,
      scaledRate,
      moneyAccountId: moneyAccount.id,
      counterAccountId,
    });

    const description = input.description ?? '';

    await updateTransactionHead(tx, context.organizationId, id, {
      occurredOn: input.occurredOn,
      description,
      currency: input.currency,
      amountMinor,
      // 与创建路径同理：表头金额取自分录，数据库的平衡触发器看不到表头。
      baseAmountMinor: lines[0].baseAmountMinor,
      scaledRate,
      rateSource: source,
      categoryId: kind === 'transfer' ? null : (input.categoryId as string),
    });

    assertLineInvariants(lines, {
      currency: input.currency,
      baseCurrency: context.baseCurrency,
      scaledRate,
      rateSource: source,
    });

    await deleteJournalLines(tx, context.organizationId, id);
    await insertJournalLines(tx, context.organizationId, id, lines);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'transaction.updated',
      entityType: 'transaction',
      entityId: id,
      before: {
        occurredOn: existing.occurredOn,
        amountMinor: existing.amountMinor.toString(),
        currency: existing.currency,
        categoryId: existing.categoryId,
        description: existing.description,
      },
      after: {
        occurredOn: input.occurredOn,
        amountMinor: amountMinor.toString(),
        currency: input.currency,
        categoryId: kind === 'transfer' ? null : (input.categoryId ?? null),
        description,
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

    assertPeriodOpen(existing.occurredOn, context.lockedUntil);

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
