'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission } from '@/server/auth/guard';
import { buildJournalLines, LedgerError, type TransactionKind } from '@/server/domain/ledger';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import {
  parseRateToScaled,
  RATE_SCALE,
  type RateSource,
} from '@/server/domain/exchange-rate';
import { assertPeriodOpen } from '@/server/domain/period-lock';
import { canEditTransaction } from '@/server/domain/permissions';
import { findRate } from '@/server/repositories/exchange-rates';
import { getMoneyAccount } from '@/server/repositories/accounts';
import { getCategoryWithAccount } from '@/server/repositories/categories';
import { recordAudit } from '@/server/repositories/audit-logs';
import { AuthError } from '@/server/auth/guard';
import {
  deleteJournalLines,
  findTransactionByClientUuid,
  getTransactionDetail,
  insertJournalLines,
  insertTransaction,
  markVoided,
  updateTransactionHead,
} from '@/server/repositories/transactions';

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
 * 决定这笔交易用哪个汇率。
 *
 * 手工汇率优先：用户当场看到的银行牌价比缓存更可信。
 * 没有手工汇率时才查缓存，且查不到就报错而不是退回 1——
 * 静默按 1:1 折算会把外币金额直接写错，且事后无法从数据里看出来。
 */
export async function resolveRate(
  tx: Tx,
  args: {
    currency: string;
    baseCurrency: string;
    occurredOn: string;
    manualRate?: string;
  },
): Promise<{ scaledRate: bigint; source: RateSource }> {
  const { currency, baseCurrency, occurredOn, manualRate } = args;

  if (manualRate !== undefined && manualRate !== '') {
    return { scaledRate: parseRateToScaled(manualRate), source: 'manual' };
  }

  if (currency === baseCurrency) {
    return { scaledRate: RATE_SCALE, source: 'auto' };
  }

  const cached = await findRate(tx, currency, baseCurrency, occurredOn);
  if (!cached) {
    throw new LedgerError(
      `No exchange rate available for ${currency} to ${baseCurrency} on ${occurredOn}. Enter one manually.`,
    );
  }

  return { scaledRate: cached.scaledRate, source: 'auto' };
}

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
    const { scaledRate, source } = await resolveRate(tx, {
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
