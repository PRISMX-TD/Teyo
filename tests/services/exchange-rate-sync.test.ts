import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withoutUserContext } from '@/server/db/transaction';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import { findRate, upsertRates } from '@/server/repositories/exchange-rates';
import {
  AUTO_RATE_CURRENCIES,
  fetchRatesFromFrankfurter,
  syncRatesForDate,
} from '@/server/services/exchange-rate-sync';

function fakeFetch(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

/**
 * 一个会照着 symbols= 参数**如实作答**的假 Frankfurter。
 *
 * 这些用例原来用的是手写的固定 payload（只有 SGD 与 USD 两个键），测的是
 * 「响应怎么映射成 rate 行」。fetchRatesFromFrankfurter 后来加了一条完整性
 * 断言——要了什么就必须回什么——之后那些固定 payload 就成了「提供方漏回了
 * 九个币种」，于是全部报错。
 *
 * 那条断言本身是对的，而且正是为了抓真问题：Frankfurter 对不认识的 symbol
 * **不报错**，它返回 HTTP 200 并把那几个键悄悄省掉（已实测）。VND 与 TWD
 * 就是这样从来没被同步过，而同步任务每天都报成功。
 *
 * 所以要改的是假实现而不是断言：让它像真实提供方一样按请求作答，再单独用
 * omit 参数去构造「提供方漏回一个币种」这一种情况。
 */
function fakeFrankfurter(options: {
  /** 覆盖某几个币种的汇率，其余用一个固定值。 */
  rates?: Record<string, number>;
  /** 提供方回的日期（周末会回最近一个工作日）。缺省等于请求日期。 */
  date?: string;
  /** 故意不回这几个币种——用来测完整性断言。 */
  omit?: readonly string[];
  /** 记录每次请求的 URL，供断言 symbols 用。 */
  onRequest?: (url: string) => void;
} = {}): typeof fetch {
  return (async (url: string) => {
    options.onRequest?.(String(url));

    const parsed = new URL(String(url));
    const requested = (parsed.searchParams.get('symbols') ?? '').split(',').filter(Boolean);
    const requestedDate = parsed.pathname.split('/').pop() ?? '';
    const omit = new Set(options.omit ?? []);

    const rates: Record<string, number> = {};
    for (const code of requested) {
      if (omit.has(code)) continue;
      rates[code] = options.rates?.[code] ?? 0.5;
    }

    return new Response(
      JSON.stringify({
        amount: 1,
        base: parsed.searchParams.get('base'),
        date: options.date ?? requestedDate,
        rates,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

const MYR_SGD = {
  baseCurrency: 'MYR',
  quoteCurrency: 'SGD',
  scaledRate: 31_250000n,
  rateDate: '2026-08-03',
  source: 'frankfurter',
};

// exchange_rates 是全局共享表，没有公司维度。清理限定在测试用的日期区间，
// 避免 delete from exchange_rates 把真实数据一起抹掉。
async function clearTestRates() {
  await admin`delete from exchange_rates where rate_date between '2026-08-01' and '2026-08-31'`;
}

beforeEach(clearTestRates);

afterAll(async () => {
  await clearTestRates();
  await admin.end();
});

describe('fetchRatesFromFrankfurter', () => {
  it('maps the response into scaled rate rows', async () => {
    const rows = await fetchRatesFromFrankfurter(
      'MYR',
      '2026-08-03',
      fakeFrankfurter({ rates: { SGD: 0.3125, USD: 0.2119 } }),
    );

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baseCurrency: 'MYR',
          quoteCurrency: 'SGD',
          scaledRate: 31_250000n,
          rateDate: '2026-08-03',
        }),
        expect.objectContaining({ quoteCurrency: 'USD', scaledRate: 21_190000n }),
      ]),
    );
  });

  it('also records the requested date when the API returns an earlier business day', async () => {
    // 2026-08-08 是周六，Frankfurter 会回 2026-08-07 的数据。
    const rows = await fetchRatesFromFrankfurter(
      'MYR',
      '2026-08-08',
      fakeFrankfurter({ date: '2026-08-07' }),
    );

    // 每个币种都会出两行（提供方回的营业日 + 请求的那一天），所以这里断言
    // 的是**日期的集合**，而不是行的列表——假实现现在如实回答 symbols= 里
    // 要的全部币种，行数随币种数量变化，写死行数只会在加减币种时无故变红。
    expect([...new Set(rows.map((r) => r.rateDate))].sort()).toEqual([
      '2026-08-07',
      '2026-08-08',
    ]);
    // 两个日期下的币种集合必须一样——周末补记那一天要能查到同一批汇率。
    const byDate = (date: string) =>
      rows.filter((r) => r.rateDate === date).map((r) => r.quoteCurrency).sort();
    expect(byDate('2026-08-08')).toEqual(byDate('2026-08-07'));
  });

  it('does not request the base currency as its own quote', async () => {
    let requested = '';
    await fetchRatesFromFrankfurter(
      'MYR',
      '2026-08-03',
      fakeFrankfurter({ onRequest: (url) => { requested = url; } }),
    );

    const symbols = new URL(requested).searchParams.get('symbols') ?? '';
    expect(symbols.split(',')).not.toContain('MYR');
  });

  it('only requests currencies the provider actually covers', async () => {
    // VND 与 TWD 是欧洲央行不发布的币种。它们此前一直混在 symbols= 里，
    // 而 Frankfurter 对不认识的 symbol 不报错——返回 200 并悄悄省掉。
    // 于是这两个币种的汇率从来没被写进库，而同步任务每天都报成功。
    let requested = '';
    await fetchRatesFromFrankfurter(
      'MYR',
      '2026-08-03',
      fakeFrankfurter({ onRequest: (url) => { requested = url; } }),
    );

    const symbols = (new URL(requested).searchParams.get('symbols') ?? '').split(',');
    expect(symbols).not.toContain('VND');
    expect(symbols).not.toContain('TWD');
    expect(AUTO_RATE_CURRENCIES).not.toContain('VND');
    expect(AUTO_RATE_CURRENCIES).not.toContain('TWD');
  });

  it('throws when the provider silently omits a currency we asked for', async () => {
    // 这是上面那个真实缺陷的可执行形式：少回一个币种不是小事——从那天起，
    // 用那个币种记账的人会一直撞「查不到汇率」，而同步照常报成功。
    await expect(
      fetchRatesFromFrankfurter('MYR', '2026-08-03', fakeFrankfurter({ omit: ['JPY'] })),
    ).rejects.toThrow(/did not return rates for JPY/i);
  });

  it('throws when the API responds with an error status', async () => {
    await expect(
      fetchRatesFromFrankfurter('MYR', '2026-08-03', fakeFetch({ message: 'boom' }, false)),
    ).rejects.toThrow(/frankfurter/i);
  });

  it('throws when the payload is missing rates', async () => {
    await expect(
      fetchRatesFromFrankfurter('MYR', '2026-08-03', fakeFetch({ base: 'MYR' })),
    ).rejects.toThrow(/frankfurter/i);
  });
});

describe('upsertRates and findRate', () => {
  it('stores rates and reads them back without precision loss', async () => {
    // 8 位小数全部占满，验证 bigint <-> numeric(20,8) 往返无损。
    const precise = { ...MYR_SGD, scaledRate: 31_234567n };
    await withoutUserContext((tx) => upsertRates(tx, [precise]));

    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2026-08-03'));
    expect(found?.scaledRate).toBe(31_234567n);
    expect(found?.source).toBe('auto');
  });

  it('returns the inverse rate when only the opposite direction is stored', async () => {
    // 存 MYR->SGD = 0.3125，查 SGD->MYR 应得 3.2
    await withoutUserContext((tx) => upsertRates(tx, [MYR_SGD]));

    const found = await withoutUserContext((tx) => findRate(tx, 'SGD', 'MYR', '2026-08-03'));
    expect(found?.scaledRate).toBe(3_20000000n);
  });

  it('returns a rate of exactly 1 when both currencies match', async () => {
    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'MYR', '2026-08-03'));
    expect(found?.scaledRate).toBe(RATE_SCALE);
  });

  it('falls back to the most recent earlier date within the lookback window', async () => {
    await withoutUserContext((tx) => upsertRates(tx, [MYR_SGD]));

    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2026-08-05'));
    expect(found?.scaledRate).toBe(31_250000n);
  });

  it('prefers the nearest earlier date when several are stored', async () => {
    await withoutUserContext((tx) =>
      upsertRates(tx, [
        { ...MYR_SGD, rateDate: '2026-08-03', scaledRate: 31_000000n },
        { ...MYR_SGD, rateDate: '2026-08-05', scaledRate: 32_000000n },
      ]),
    );

    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2026-08-06'));
    expect(found?.scaledRate).toBe(32_000000n);
  });

  it('never returns a rate from after the requested date', async () => {
    // 用未来的汇率折算历史交易会篡改已入账的金额。
    await withoutUserContext((tx) =>
      upsertRates(tx, [{ ...MYR_SGD, rateDate: '2026-08-10' }]),
    );

    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2026-08-03'));
    expect(found).toBeNull();
  });

  it('returns null when the stored rate is older than the lookback window', async () => {
    await withoutUserContext((tx) => upsertRates(tx, [{ ...MYR_SGD, rateDate: '2026-08-01' }]));

    // 相隔 20 天，超出 7 天窗口。
    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2026-08-21'));
    expect(found).toBeNull();
  });

  it('returns null when nothing is stored at all', async () => {
    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2026-08-03'));
    expect(found).toBeNull();
  });

  it('is idempotent for the same base, quote and date', async () => {
    await withoutUserContext((tx) => upsertRates(tx, [MYR_SGD]));
    await withoutUserContext((tx) => upsertRates(tx, [{ ...MYR_SGD, scaledRate: 31_000000n }]));

    const rows = await admin`
      select rate from exchange_rates
      where base_currency = 'MYR' and quote_currency = 'SGD' and rate_date = '2026-08-03'
    `;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].rate)).toBeCloseTo(0.31, 8);
  });

  it('handles an empty batch without touching the database', async () => {
    const count = await withoutUserContext((tx) => upsertRates(tx, []));
    expect(count).toBe(0);
  });
});

describe('syncRatesForDate', () => {
  it('stores rates for every base currency', async () => {
    const result = await syncRatesForDate('2026-08-03', fakeFrankfurter());

    expect(result.inserted).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    const [{ count }] = await admin`
      select count(*)::int as count from exchange_rates where rate_date = '2026-08-03'
    `;
    expect(count).toBeGreaterThan(0);
  });

  it('throws when every base currency fails', async () => {
    await expect(
      syncRatesForDate('2026-08-03', fakeFetch({ message: 'boom' }, false)),
    ).rejects.toThrow(/every base currency/i);
  });

  it('still reports success when only some base currencies fail', async () => {
    let call = 0;
    const honest = fakeFrankfurter();
    const flaky = (async (url: string) => {
      call += 1;
      // 第一个 base 失败，其余成功：整次同步不应中断。
      if (call === 1) return new Response('nope', { status: 500 });
      return honest(url as unknown as RequestInfo);
    }) as unknown as typeof fetch;

    const result = await syncRatesForDate('2026-08-03', flaky);
    expect(result.inserted).toBeGreaterThan(0);
    // 但坏掉的那个必须出现在返回值里——只回一个 inserted 数字的话，
    // 「部分失败」与「全部成功」在监控上长得一模一样。
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/^MYR: /);
  });
});
