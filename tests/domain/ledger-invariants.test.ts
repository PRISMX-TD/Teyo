import { describe, expect, it } from 'vitest';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import {
  LedgerError,
  assertLineInvariants,
  buildLines,
  type BuildLinesContext,
  type DraftJournalLine,
} from '@/server/domain/ledger';
import { templateFor } from '@/server/domain/posting-templates';

const BANK = 'account-bank';
const SALES = 'account-sales';

/**
 * 生产路径构造分录的那两步：templateFor 定方向，buildLines 换算本位币。
 * 这里原来调的是 buildJournalLines，它已随记账方向的第二份定义一起删除。
 */
function postedLines(amountMinor: bigint, ctx: BuildLinesContext): DraftJournalLine[] {
  return buildLines(
    templateFor({ type: 'income', moneyAccountId: BANK, revenueAccountId: SALES, amountMinor }),
    ctx,
  );
}

describe('assertLineInvariants - I3 base amount consistency', () => {
  it('accepts lines the boundary actually builds', () => {
    const lines = postedLines(10000n, {
      currency: 'SGD',
      baseCurrency: 'MYR',
      scaledRate: 3_50000000n,
    });

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'SGD',
        baseCurrency: 'MYR',
        scaledRate: 3_50000000n,
        rateSource: 'auto',
      }),
    ).not.toThrow();
  });

  it('rejects a line whose base amount does not match the recorded rate', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 10000n, baseAmountMinor: 34000n },
      { accountId: SALES, direction: 'credit', amountMinor: 10000n, baseAmountMinor: 34000n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'SGD',
        baseCurrency: 'MYR',
        scaledRate: 3_50000000n,
        rateSource: 'auto',
      }),
    ).toThrow(LedgerError);
  });

  // I3 现在允许一行偏离自己的换算结果（buildLines 吸收舍入残差的那一行）。
  // 下面三条钉住这个口子有多大：它不是一个「差不多就行」的容差。
  //
  // 这一条正是产品声明的失败模式：两条腿错得一模一样，借贷合计照样相等，
  // 数据库那个延迟触发器完全看不出来。放宽 I3 时最容易顺手放过的就是它。
  it('rejects an error applied equally to both legs, which the database cannot see', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 10000n, baseAmountMinor: 35001n },
      { accountId: SALES, direction: 'credit', amountMinor: 10000n, baseAmountMinor: 35001n },
    ];

    // 两边合计相等（35001 = 35001），原币也配平，只有逐行核对能发现。
    expect(() =>
      assertLineInvariants(lines, {
        currency: 'SGD',
        baseCurrency: 'MYR',
        scaledRate: 3_50000000n,
        rateSource: 'auto',
      }),
    ).toThrow(/at most one/i);
  });

  it('rejects a single line off by more than rounding could account for', () => {
    // 原币两边就不配平（10000 借 / 9000 贷），却在本位币这边用一行把差额
    // 补平了。少了幅度上界，这组行就只是「一行偏离」，会被当成舍入残差放过。
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 10000n, baseAmountMinor: 35000n },
      { accountId: SALES, direction: 'credit', amountMinor: 9000n, baseAmountMinor: 35000n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'SGD',
        baseCurrency: 'MYR',
        scaledRate: 3_50000000n,
        rateSource: 'auto',
      }),
    ).toThrow(/at most/i);
  });

  it('rejects a one-unit deviation that leaves the base sides apart', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 10000n, baseAmountMinor: 35001n },
      { accountId: SALES, direction: 'credit', amountMinor: 10000n, baseAmountMinor: 35000n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'SGD',
        baseCurrency: 'MYR',
        scaledRate: 3_50000000n,
        rateSource: 'auto',
      }),
    ).toThrow(/balanced in base currency/i);
  });

  // 允许的那一种：三行，逐行换算后两边差 1，那 1 落在其中一行上。
  // 这就是 buildLines 对一笔三行外币事件会产出的形状——原来的 I3 会拒绝它，
  // 也就是说边界上的下一句会把一笔正确的分录判错。
  it('accepts the one line that absorbed a genuine rounding residual', () => {
    const RATE = 4_71834900n;
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 5n, baseAmountMinor: 24n },
      { accountId: SALES, direction: 'credit', amountMinor: 3n, baseAmountMinor: 15n }, // 自身换算是 14
      { accountId: 'account-tax', direction: 'credit', amountMinor: 2n, baseAmountMinor: 9n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'USD',
        baseCurrency: 'MYR',
        scaledRate: RATE,
        rateSource: 'auto',
      }),
    ).not.toThrow();
  });
});

describe('assertLineInvariants - I4 fabricated 1:1 rate', () => {
  it('rejects a foreign-currency posting recorded at an auto rate of exactly 1', () => {
    // 这正是 server/actions/recurring.ts 当前产生的形状：
    // base = amount 且 scaledRate = 1.0，两者自洽，I3 抓不到。
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 50000n, baseAmountMinor: 50000n },
      { accountId: SALES, direction: 'credit', amountMinor: 50000n, baseAmountMinor: 50000n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'USD',
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
        rateSource: 'auto',
      }),
    ).toThrow(LedgerError);
  });

  it('allows a rate of exactly 1 when the user entered it manually', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 50000n, baseAmountMinor: 50000n },
      { accountId: SALES, direction: 'credit', amountMinor: 50000n, baseAmountMinor: 50000n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'USD',
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
        rateSource: 'manual',
      }),
    ).not.toThrow();
  });

  it('allows a rate of exactly 1 for a domestic posting', () => {
    const lines = postedLines(50000n, {
      currency: 'MYR',
      baseCurrency: 'MYR',
      scaledRate: RATE_SCALE,
    });

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'MYR',
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
        rateSource: 'auto',
      }),
    ).not.toThrow();
  });

  it('does not false-positive when conversion legitimately preserves the number', () => {
    // JPY 小数位为 0，MYR 为 2。JPY 100 在汇率 0.01 下 = MYR 1.00 = 100 minor。
    // 金额相等但汇率不是 1，属于合法情形。
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 100n, baseAmountMinor: 100n },
      { accountId: SALES, direction: 'credit', amountMinor: 100n, baseAmountMinor: 100n },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: 'JPY',
        baseCurrency: 'MYR',
        scaledRate: 1000000n, // 0.01
        rateSource: 'auto',
      }),
    ).not.toThrow();
  });
});

describe('assertLineInvariants - property sweep', () => {
  const PAIRS: [string, string][] = [
    ['MYR', 'MYR'], ['SGD', 'MYR'], ['USD', 'MYR'],
    ['JPY', 'MYR'], ['MYR', 'JPY'], ['USD', 'SGD'],
  ];
  const RATES = [RATE_SCALE, 3_50000000n, 4_71834900n, 1000000n, 25_00000000n];

  it('every posting the boundary builds satisfies I3 and I4', () => {
    for (const [currency, baseCurrency] of PAIRS) {
      for (const scaledRate of RATES) {
        if (currency === baseCurrency && scaledRate !== RATE_SCALE) continue;
        for (const amountMinor of [1n, 7n, 999n, 100000n, 123456789n]) {
          const lines = postedLines(amountMinor, { currency, baseCurrency, scaledRate });

          const rateSource = currency !== baseCurrency && scaledRate === RATE_SCALE
            ? 'manual'
            : 'auto';

          expect(() =>
            assertLineInvariants(lines, { currency, baseCurrency, scaledRate, rateSource }),
          ).not.toThrow();
        }
      }
    }
  });
});
