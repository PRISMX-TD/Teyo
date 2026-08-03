import { withoutUserContext } from '@/server/db/transaction';
import { parseRateToScaled } from '@/server/domain/exchange-rate';
import { type RateRow, upsertRates } from '@/server/repositories/exchange-rates';

/** 首期市场相关币种。 */
export const SUPPORTED_CURRENCIES = [
  'MYR',
  'SGD',
  'USD',
  'CNY',
  'THB',
  'IDR',
  'PHP',
  'VND',
  'HKD',
  'TWD',
  'EUR',
  'GBP',
  'AUD',
  'JPY',
] as const;

/** 只有这几个会被用作公司本位币，作为同步的 base，减少请求量。 */
const BASE_CURRENCIES = ['MYR', 'SGD', 'USD', 'CNY'] as const;

const ENDPOINT = 'https://api.frankfurter.dev/v1';

type FrankfurterResponse = {
  base: string;
  date: string;
  rates: Record<string, number>;
};

export async function fetchRatesFromFrankfurter(
  base: string,
  onDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RateRow[]> {
  const symbols = SUPPORTED_CURRENCIES.filter((c) => c !== base).join(',');
  const url = `${ENDPOINT}/${onDate}?base=${base}&symbols=${symbols}`;

  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(
      `Frankfurter request failed with status ${response.status} for ${base} on ${onDate}.`,
    );
  }

  const payload = (await response.json()) as FrankfurterResponse;

  if (!payload?.rates || typeof payload.date !== 'string') {
    throw new Error(`Frankfurter returned an unexpected payload for ${base} on ${onDate}.`);
  }

  // Frankfurter 只有工作日数据。周末或假日请求会回最近一个工作日，
  // 两个日期都要落库，否则周末录入的交易查不到当天汇率。
  const dates = payload.date === onDate ? [onDate] : [payload.date, onDate];

  return Object.entries(payload.rates).flatMap(([quote, rate]) =>
    dates.map((rateDate) => ({
      baseCurrency: base,
      quoteCurrency: quote,
      // 经字符串转换，避免 0.1+0.2 那类浮点误差写进汇率。
      scaledRate: parseRateToScaled(rate.toString()),
      rateDate,
      source: 'frankfurter',
    })),
  );
}

export async function syncRatesForDate(
  onDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ inserted: number }> {
  let inserted = 0;
  const failures: string[] = [];

  for (const base of BASE_CURRENCIES) {
    try {
      const rows = await fetchRatesFromFrankfurter(base, onDate, fetchImpl);
      inserted += await withoutUserContext((tx) => upsertRates(tx, rows));
    } catch (error) {
      // 单个币种失败不该让整次同步失败，记录后继续下一个。
      failures.push(`${base}: ${(error as Error).message}`);
    }
  }

  if (inserted === 0 && failures.length > 0) {
    throw new Error(`Rate sync failed for every base currency. ${failures.join('; ')}`);
  }

  return { inserted };
}
