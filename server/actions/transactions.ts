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
import { findRate } from '@/server/repositories/exchange-rates';
import { getMoneyAccount } from '@/server/repositories/accounts';
import { getCategoryWithAccount } from '@/server/repositories/categories';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  findTransactionByClientUuid,
  insertJournalLines,
  insertTransaction,
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
  input: CreateTransactionInput,
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
