import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withoutUserContext } from '@/server/db/transaction';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import { findRate, upsertRates } from '@/server/repositories/exchange-rates';
import {
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
      fakeFetch({ amount: 1, base: 'MYR', date: '2026-08-03', rates: { SGD: 0.3125, USD: 0.2119 } }),
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
      fakeFetch({ amount: 1, base: 'MYR', date: '2026-08-07', rates: { SGD: 0.3125 } }),
    );

    expect(rows.map((r) => r.rateDate).sort()).toEqual(['2026-08-07', '2026-08-08']);
  });

  it('does not request the base currency as its own quote', async () => {
    let requested = '';
    const spy = (async (url: string) => {
      requested = String(url);
      return new Response(JSON.stringify({ amount: 1, base: 'MYR', date: '2026-08-03', rates: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await fetchRatesFromFrankfurter('MYR', '2026-08-03', spy);
    const symbols = new URL(requested).searchParams.get('symbols') ?? '';
    expect(symbols.split(',')).not.toContain('MYR');
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
    const result = await syncRatesForDate(
      '2026-08-03',
      fakeFetch({ amount: 1, base: 'MYR', date: '2026-08-03', rates: { SGD: 0.3125, USD: 0.2119 } }),
    );

    expect(result.inserted).toBeGreaterThan(0);
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
    const flaky = (async () => {
      call += 1;
      // 第一个币种失败，其余成功：整次同步不应中断。
      if (call === 1) return new Response('nope', { status: 500 });
      return new Response(
        JSON.stringify({ amount: 1, base: 'X', date: '2026-08-03', rates: { SGD: 0.3125 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await syncRatesForDate('2026-08-03', flaky);
    expect(result.inserted).toBeGreaterThan(0);
  });
});
