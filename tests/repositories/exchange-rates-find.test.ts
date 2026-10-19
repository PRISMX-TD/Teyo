import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withoutUserContext } from '@/server/db/transaction';
import { findRate } from '@/server/repositories/exchange-rates';

// exchange_rates 是全局共享表、没有公司维度，而 vitest 会并行跑多个文件。
// 这里只用一个别的文件都不碰的日期区间，清理也只限于它
// （tests/services/exchange-rate-sync.test.ts 用的是 2026-08）。
async function clearTestRates() {
  await admin`delete from exchange_rates where rate_date between '2032-04-01' and '2032-04-30'`;
}

async function storeRate(base: string, quote: string, rateDate: string, rate: string) {
  await admin`
    insert into exchange_rates (base_currency, quote_currency, rate, rate_date, source)
    values (${base}, ${quote}, ${rate}::numeric, ${rateDate}::date, 'frankfurter')
  `;
}

beforeEach(clearTestRates);

afterAll(async () => {
  await clearTestRates();
  await admin.end();
});

describe('findRate - direction vs. recency', () => {
  it('prefers a same-day inverse rate over a stale direct rate', async () => {
    // 钉住：原来先查正方向，窗口里只要有一条（哪怕 6 天前）就直接返回，
    // 当天存的反方向汇率永远轮不到。
    await storeRate('MYR', 'SGD', '2032-04-04', '0.30000000'); // 6 天前，正方向
    await storeRate('SGD', 'MYR', '2032-04-10', '4.00000000'); // 当天，反方向

    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2032-04-10'));
    // 1 / 4.0 = 0.25，按 8 位小数缩放。旧实现会返回 0.30。
    expect(found?.scaledRate).toBe(25_000000n);
  });

  it('prefers the direct rate when both directions exist on the same date', async () => {
    await storeRate('MYR', 'SGD', '2032-04-10', '0.30000000');
    await storeRate('SGD', 'MYR', '2032-04-10', '4.00000000');

    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2032-04-10'));
    expect(found?.scaledRate).toBe(30_000000n);
  });

  it('still uses a newer direct rate over an older inverse rate', async () => {
    await storeRate('SGD', 'MYR', '2032-04-05', '4.00000000');
    await storeRate('MYR', 'SGD', '2032-04-09', '0.30000000');

    const found = await withoutUserContext((tx) => findRate(tx, 'MYR', 'SGD', '2032-04-10'));
    expect(found?.scaledRate).toBe(30_000000n);
  });
});
