import type { Tx } from '@/server/db/transaction';
import { LedgerError } from '@/server/domain/ledger';
import {
  parseRateToScaled,
  RATE_SCALE,
  type RateSource,
} from '@/server/domain/exchange-rate';
import { findRate } from '@/server/repositories/exchange-rates';

/**
 * 这个入口的界面上有没有一个能填汇率的地方。
 *
 * 缓存里查不到汇率时，那句报错要告诉用户接下来做什么，而「做什么」只有
 * 调用方知道。交易表单上就有 RateField（见 components/transaction/
 * rate-field.tsx），当场填一个就能存下去；定期规则的补记没有——
 * recurring_transactions 里没有汇率字段，界面上也没有这一栏，
 * 折旧与手工凭证同样没有（createJournal 的入参里根本没有 exchangeRate）。
 * 五个调用点里只有两个能填。
 *
 * 所以这是一个必填参数，不是带默认值的可选项：默认成 'available' 会让
 * 三个填不了的入口继续说那句做不到的话，默认成 'unavailable' 会让交易
 * 表单上的用户绕远路去做他面前就能做的事。加新入口的人必须回答这个问题。
 */
export type ManualRateEntry = 'available' | 'unavailable';

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
    manualRateEntry: ManualRateEntry;
  },
): Promise<{ scaledRate: bigint; source: RateSource }> {
  const { currency, baseCurrency, occurredOn, manualRate, manualRateEntry } = args;

  if (manualRate !== undefined && manualRate !== '') {
    return { scaledRate: parseRateToScaled(manualRate), source: 'manual' };
  }

  if (currency === baseCurrency) {
    return { scaledRate: RATE_SCALE, source: 'auto' };
  }

  const cached = await findRate(tx, currency, baseCurrency, occurredOn);
  if (!cached) {
    // 这句话原来一律以「Enter one manually.」结尾。定期规则的补记走到这里
    // 时，用户面前没有任何可以填汇率的地方——一条指向不存在的输入框的提示，
    // 对一个不懂会计的用户就是死路。而这条路径偏偏最常撞上：findRate 只回溯
    // 7 天，cron 只同步「今天」，任何补记历史月份的外币规则都查不到汇率。
    const remedy =
      manualRateEntry === 'available'
        ? 'Enter one manually.'
        : 'Record this entry yourself under Transactions, where you can type the rate in.';

    throw new LedgerError(
      `No exchange rate available for ${currency} to ${baseCurrency} on ${occurredOn}. ${remedy}`,
    );
  }

  return { scaledRate: cached.scaledRate, source: 'auto' };
}
