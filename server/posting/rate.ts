import type { Tx } from '@/server/db/transaction';
import { LedgerError } from '@/server/domain/ledger';
import {
  parseRateToScaled,
  RATE_SCALE,
  type RateSource,
} from '@/server/domain/exchange-rate';
import { findRate } from '@/server/repositories/exchange-rates';

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
