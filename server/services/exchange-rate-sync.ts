import { withoutUserContext } from '@/server/db/transaction';
import { parseRateToScaled } from '@/server/domain/exchange-rate';
import { type RateRow, upsertRates } from '@/server/repositories/exchange-rates';

/**
 * 应用允许用户选择的交易币种。
 *
 * 这个列表回答的是「录一笔交易时下拉里有什么」，不是「哪些能自动查到
 * 汇率」——后者是 AUTO_RATE_CURRENCIES。马来西亚的商户确实会跟越南、
 * 台湾往来，把 VND/TWD 从可选币种里删掉是拿掉一个真实需求，只为了让
 * 一张表格看起来整齐。
 */
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

/**
 * 汇率源实际覆盖的币种。
 *
 * Frankfurter 转发的是欧洲央行的参考汇率，而欧洲央行不发布 VND 与 TWD。
 * 这两个币种此前一直混在 symbols= 参数里，而 Frankfurter 对不认识的
 * symbol **不报错**——它返回 HTTP 200，只是把那几个键从 rates 里悄悄
 * 省掉（已实测：`?base=MYR&symbols=SGD,USD,VND,TWD` 回 200，body 里只有
 * SGD 与 USD）。
 *
 * 于是 VND/TWD 的汇率从来没有被写进 exchange_rates，而代码里没有任何
 * 一处会说出这件事：用户选了 VND，findRate 查不到，postJournal 抛
 * 「No exchange rate available」，他看到的是一句像是临时故障的话，实际
 * 是一个永远不会好转的状态。
 *
 * 分成两个列表之后，「这个币种能不能自动查汇率」变成一个可以被界面提前
 * 问出来的问题（见 isAutoRateCurrency）。
 *
 * 刷新方式：`curl https://api.frankfurter.dev/v1/currencies`。钉成常量而不
 * 是每次同步前先拉一遍：多一次网络往返换来的是「列表可能在两次运行之间
 * 变化」这种不确定性，而下面的完整性断言已经能在覆盖范围缩小时报警。
 */
export const AUTO_RATE_CURRENCIES = SUPPORTED_CURRENCIES.filter(
  (code) => code !== 'VND' && code !== 'TWD',
);

/** 只有这几个会被用作公司本位币，作为同步的 base，减少请求量。 */
const BASE_CURRENCIES = ['MYR', 'SGD', 'USD', 'CNY'] as const;

const ENDPOINT = 'https://api.frankfurter.dev/v1';

/** 这个币种能不能自动查到汇率。查不到的必须由用户手工填。 */
export function isAutoRateCurrency(code: string): boolean {
  return (AUTO_RATE_CURRENCIES as readonly string[]).includes(code);
}

type FrankfurterResponse = {
  base: string;
  date: string;
  rates: Record<string, number>;
};

/**
 * 把 JSON 里的数字安全地变成 parseRateToScaled 认得的十进制字符串。
 *
 * 这里原来直接 `rate.toString()`，附注释说「经字符串转换，避免 0.1+0.2
 * 那类浮点误差写进汇率」。那句话把防线放错了位置：response.json() 已经
 * 把字面量解析成了 double，浮点该出的误差在那一步就出完了，之后再怎么
 * 转字符串也追不回来。实际救了这段代码的是量级——参考汇率只有五六位
 * 有效数字，double 完全放得下，toString 能精确往返。
 *
 * toString 真正会出问题的是另外两件事，而它们是这个函数存在的理由：
 *   1. 指数记法。绝对值小于 1e-6 时 Number.toString 给出 "5e-9"，而
 *      parseRateToScaled 的正则 ^\d+(\.\d+)?$ 不接受 e —— 整个 base 的
 *      同步会因为一个小币种而失败。
 *   2. 超过 8 位小数。parseRateToScaled 明确拒绝，理由是 exchange_rate
 *      列是 numeric(20,8)，多出来的位数落库时会被静默截断。
 *
 * toFixed(8) 一次解决两个：它不产生指数记法（要到 1e21 才会，汇率到不了），
 * 并且把精度钉在列能存下的 8 位上。
 */
function toRateString(rate: number, quote: string, base: string): string {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Frankfurter returned a non-positive rate for ${base}->${quote}: ${rate}`);
  }

  const fixed = rate.toFixed(8);

  // 小于 5e-9 的汇率在 8 位小数上就是 0，而 0 汇率不可能是对的。
  // 与其让 parseRateToScaled 抛一句「must be greater than zero」（读的人
  // 会以为是解析出了问题），不如在这里说清楚是量级放不下。
  if (Number(fixed) === 0) {
    throw new Error(
      `Rate for ${base}->${quote} (${rate}) is too small to store at 8 decimal places.`,
    );
  }

  return fixed;
}

export async function fetchRatesFromFrankfurter(
  base: string,
  onDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RateRow[]> {
  const requested = AUTO_RATE_CURRENCIES.filter((c) => c !== base);
  const url = `${ENDPOINT}/${onDate}?base=${base}&symbols=${requested.join(',')}`;

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

  // 完整性断言：要了什么就必须回什么。
  //
  // 这是上面那段「静默省略」的对策。少一个币种不是小事——它意味着从今天
  // 起，用那个币种记账的人会一直撞「查不到汇率」，而同步任务照常报成功。
  // 断言让「汇率源的覆盖范围变了」这件事在它发生的那一天就被看见，而不是
  // 等某个用户来问为什么他的单子存不下去。
  const missing = requested.filter((code) => !(code in payload.rates));
  if (missing.length > 0) {
    throw new Error(
      `Frankfurter did not return rates for ${missing.join(', ')} against ${base} on ${onDate}. ` +
        'Update AUTO_RATE_CURRENCIES if the provider dropped them.',
    );
  }

  // Frankfurter 只有工作日数据。周末或假日请求会回最近一个工作日，
  // 两个日期都要落库，否则周末录入的交易查不到当天汇率。
  const dates = payload.date === onDate ? [onDate] : [payload.date, onDate];

  return Object.entries(payload.rates).flatMap(([quote, rate]) =>
    dates.map((rateDate) => ({
      baseCurrency: base,
      quoteCurrency: quote,
      scaledRate: parseRateToScaled(toRateString(rate, quote, base)),
      rateDate,
      source: 'frankfurter',
    })),
  );
}

export async function syncRatesForDate(
  onDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ inserted: number; failures: string[] }> {
  let inserted = 0;
  const failures: string[] = [];

  for (const base of BASE_CURRENCIES) {
    try {
      const rows = await fetchRatesFromFrankfurter(base, onDate, fetchImpl);
      inserted += await withoutUserContext((tx) => upsertRates(tx, rows));
    } catch (error) {
      // 单个 base 失败不该让整次同步失败，记录后继续下一个。
      // MoneyError 继承 Error，所以这一条也覆盖了汇率解析失败。
      failures.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (inserted === 0 && failures.length > 0) {
    throw new Error(`Rate sync failed for every base currency. ${failures.join('; ')}`);
  }

  // failures 返回给调用方而不是就地吞掉：四个 base 里坏了一个，同步整体
  // 仍然算成功（三个 base 的汇率确实写进去了），但那一个坏掉的必须出现在
  // cron 的响应体里，否则「部分失败」与「全部成功」在监控上长得一模一样。
  return { inserted, failures };
}
