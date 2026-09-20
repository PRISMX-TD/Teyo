import { describe, expect, it } from 'vitest';
import { convertToBaseMinor, parseRateToScaled } from '@/server/domain/exchange-rate';
import { MoneyError } from '@/server/domain/money';
import {
  allocateProRata,
  clearedBaseMinor,
  fxAdjustmentClientUuid,
  fxAdjustmentEvent,
  fxResultMinor,
  planFxAdjustment,
  summariseFxResults,
  FX_RESULT_KINDS,
} from '@/server/services/fx-settlement';

/**
 * 汇兑损益的算术全部是纯函数，这个文件一次数据库都不碰。
 *
 * 这样分层不只是为了跑得快：外币结算里真正容易错的是「被清掉的应收原本值
 * 多少本位币」这一个数，它只依赖四个整数。把它与建公司、建发票、过账那一
 * 长串隔开之后，一个断言失败就直接指向算错的那一步，而不是指向「集成测试
 * 挂了」。
 */

const MYR = 'MYR';
const USD = 'USD';
const JPY = 'JPY';

/** 一张外币发票开票时记进应收的本位币金额。 */
function invoiceBase(amountMinor: bigint, currency: string, rate: string): bigint {
  return convertToBaseMinor({
    amountMinor,
    currency,
    baseCurrency: MYR,
    scaledRate: parseRateToScaled(rate),
  });
}

describe('clearedBaseMinor - 被清掉的那部分应收原本值多少本位币', () => {
  it('全额一次收清时等于开票时记进去的那个数', () => {
    const base = invoiceBase(100_000n, USD, '4.20'); // 1,000.00 USD -> 4,200.00 MYR

    expect(
      clearedBaseMinor({
        documentBaseAmountMinor: base,
        documentTotalMinor: 100_000n,
        alreadySettledMinor: 0n,
        settledMinor: 100_000n,
      }),
    ).toBe(base);
  });

  it('部分收款按比例分摊，且用的是 half-up 而不是截断', () => {
    // 1,000.00 USD @ 4.2345 -> 4,234.50 MYR。收 333.33 USD，
    // 精确值 423450 * 33333 / 100000 = 141,148.67985，half-up 进 141149。
    const base = invoiceBase(100_000n, USD, '4.2345');
    expect(base).toBe(423_450n);

    expect(
      clearedBaseMinor({
        documentBaseAmountMinor: base,
        documentTotalMinor: 100_000n,
        alreadySettledMinor: 0n,
        settledMinor: 33_333n,
      }),
    ).toBe(141_149n);
  });

  it('分三次不等额收完之后，逐次分摊之和精确等于开票时的本位币金额', () => {
    const base = invoiceBase(100_000n, USD, '4.2345');
    const receipts = [33_333n, 33_333n, 33_334n];

    let alreadySettled = 0n;
    let cleared = 0n;
    for (const receipt of receipts) {
      cleared += clearedBaseMinor({
        documentBaseAmountMinor: base,
        documentTotalMinor: 100_000n,
        alreadySettledMinor: alreadySettled,
        settledMinor: receipt,
      });
      alreadySettled += receipt;
    }

    // 关键：不是「约等于」。最后一笔把尾数全吃掉，应收上不许剩一分。
    expect(alreadySettled).toBe(100_000n);
    expect(cleared).toBe(base);
  });

  it('换一组更刁钻的分法，结论不变——与分几次、每次多少无关', () => {
    const base = invoiceBase(99_999n, USD, '4.33333333');
    const receipts = [1n, 7n, 33_333n, 66_657n, 1n];

    let alreadySettled = 0n;
    let cleared = 0n;
    for (const receipt of receipts) {
      cleared += clearedBaseMinor({
        documentBaseAmountMinor: base,
        documentTotalMinor: 99_999n,
        alreadySettledMinor: alreadySettled,
        settledMinor: receipt,
      });
      alreadySettled += receipt;
    }

    expect(alreadySettled).toBe(99_999n);
    expect(cleared).toBe(base);
  });

  it('超额核销时多出来的那一截不分摊——它背后没有任何应收', () => {
    const base = invoiceBase(100_000n, USD, '4.20');

    const first = clearedBaseMinor({
      documentBaseAmountMinor: base,
      documentTotalMinor: 100_000n,
      alreadySettledMinor: 0n,
      settledMinor: 120_000n,
    });
    expect(first).toBe(base);

    // 已经收满之后再来一笔，清掉的是零。
    expect(
      clearedBaseMinor({
        documentBaseAmountMinor: base,
        documentTotalMinor: 100_000n,
        alreadySettledMinor: 120_000n,
        settledMinor: 5_000n,
      }),
    ).toBe(0n);
  });

  it('负数金额直接抛错，不静默当成零', () => {
    expect(() =>
      clearedBaseMinor({
        documentBaseAmountMinor: 1_000n,
        documentTotalMinor: 100n,
        alreadySettledMinor: 0n,
        settledMinor: -1n,
      }),
    ).toThrow(MoneyError);
  });
});

describe('fxResultMinor - 四种场景', () => {
  it('同币种：R1 = R2 = 1，没有差额', () => {
    const base = convertToBaseMinor({
      amountMinor: 100_000n,
      currency: MYR,
      baseCurrency: MYR,
      scaledRate: parseRateToScaled('1'),
    });

    const result = fxResultMinor({
      side: 'receivable',
      settlementBaseMinor: base,
      clearedBaseMinor: base,
    });

    expect(result).toBe(0n);
    expect(planFxAdjustment(result)).toBeNull();
  });

  it('升值：开票 4.20、收款 4.50，收到的本位币更多 —— 汇兑收益', () => {
    const cleared = invoiceBase(100_000n, USD, '4.20'); // 420,000 sen
    const settlement = invoiceBase(100_000n, USD, '4.50'); // 450,000 sen

    const result = fxResultMinor({
      side: 'receivable',
      settlementBaseMinor: settlement,
      clearedBaseMinor: cleared,
    });

    expect(result).toBe(30_000n);
    expect(planFxAdjustment(result)).toEqual({ kind: 'gain', amountMinor: 30_000n });
  });

  it('贬值：开票 4.20、收款 4.00 —— 汇兑损失', () => {
    const cleared = invoiceBase(100_000n, USD, '4.20');
    const settlement = invoiceBase(100_000n, USD, '4.00');

    const result = fxResultMinor({
      side: 'receivable',
      settlementBaseMinor: settlement,
      clearedBaseMinor: cleared,
    });

    expect(result).toBe(-20_000n);
    expect(planFxAdjustment(result)).toEqual({ kind: 'loss', amountMinor: 20_000n });
  });

  it('零小数币种（JPY -> MYR）：两端 exponent 相差 2，换算不能少一个数量级', () => {
    // 100,000 日元（exponent 0）@ 0.031 = 3,100.00 令吉（exponent 2）。
    const cleared = invoiceBase(100_000n, JPY, '0.031');
    expect(cleared).toBe(310_000n);

    // B1 里那份手抄实现算的是 amountMinor * scaledRate / RATE_SCALE
    // = 100000 * 3100000 / 10^8 = 3100 sen = 31.00 MYR，整整差 100 倍。
    const naive = (100_000n * parseRateToScaled('0.031')) / 10n ** 8n;
    expect(naive).toBe(3_100n);
    expect(naive).not.toBe(cleared);

    const settlement = invoiceBase(100_000n, JPY, '0.030');
    expect(settlement).toBe(300_000n);

    const result = fxResultMinor({
      side: 'receivable',
      settlementBaseMinor: settlement,
      clearedBaseMinor: cleared,
    });
    expect(planFxAdjustment(result)).toEqual({ kind: 'loss', amountMinor: 10_000n });
  });

  it('应付侧符号相反：付出去的本位币比当初记的少就是收益', () => {
    const cleared = invoiceBase(100_000n, USD, '4.50'); // 记账单时 450,000
    const settlement = invoiceBase(100_000n, USD, '4.20'); // 付款时只花了 420,000

    expect(
      fxResultMinor({ side: 'payable', settlementBaseMinor: settlement, clearedBaseMinor: cleared }),
    ).toBe(30_000n);

    expect(
      fxResultMinor({ side: 'receivable', settlementBaseMinor: settlement, clearedBaseMinor: cleared }),
    ).toBe(-30_000n);
  });
});

describe('summariseFxResults - 收益与损失分开汇总', () => {
  it('同一笔收款里有赚有亏时不相抵', () => {
    expect(summariseFxResults([1_200n, -300n, 0n, -50n])).toEqual({
      gainMinor: 1_200n,
      lossMinor: 350n,
    });
  });

  it('全部为零时两边都是零，调用方据此一笔调整凭证也不出', () => {
    expect(summariseFxResults([0n, 0n])).toEqual({ gainMinor: 0n, lossMinor: 0n });
  });
});

describe('fxAdjustmentEvent - 方向', () => {
  const accounts = {
    controlAccountId: 'ar',
    fxGainAccountId: 'gain',
    fxLossAccountId: 'loss',
  };

  it('收益：借控制科目 / 贷 fx-gain', () => {
    expect(fxAdjustmentEvent({ kind: 'gain', amountMinor: 500n }, accounts)).toEqual({
      type: 'journal',
      debitAccountId: 'ar',
      creditAccountId: 'gain',
      amountMinor: 500n,
    });
  });

  it('损失：借 fx-loss / 贷控制科目', () => {
    expect(fxAdjustmentEvent({ kind: 'loss', amountMinor: 500n }, accounts)).toEqual({
      type: 'journal',
      debitAccountId: 'loss',
      creditAccountId: 'ar',
      amountMinor: 500n,
    });
  });
});

describe('allocateProRata - 逐项本位币金额之和必须等于整笔换算的结果', () => {
  it('三项分摊之和精确等于总额（逐项各自换算则会差一分）', () => {
    const currency = USD;
    const rate = parseRateToScaled('4.505');
    // 10,001 分 @ 4.505 = 45,054.505 -> half-up 45,055，三项合计 135,165；
    // 而 30,003 分整笔换算是 135,163.515 -> 135,164。差的那一分正是本函数
    // 要消灭的东西：贷方记的是整笔那个数，逐项去算汇兑差额就会多认一分。
    const parts = [10_001n, 10_001n, 10_001n];
    const totalOriginal = 30_003n;

    const totalBase = convertToBaseMinor({
      amountMinor: totalOriginal,
      currency,
      baseCurrency: MYR,
      scaledRate: rate,
    });

    const perItemIndependently = parts.map((part) =>
      convertToBaseMinor({ amountMinor: part, currency, baseCurrency: MYR, scaledRate: rate }),
    );
    // 各自换算之后合计比整笔换算多一分——半进位不可加，这正是要 allocateProRata 的理由。
    expect(perItemIndependently.reduce((a, b) => a + b, 0n)).not.toBe(totalBase);

    const allocated = allocateProRata(totalBase, totalOriginal, parts);
    expect(allocated.reduce((a, b) => a + b, 0n)).toBe(totalBase);
  });

  it('有一部分没有核销任何单据时，未分摊的那一截正好是它应得的份额', () => {
    const allocated = allocateProRata(1_000n, 100n, [40n, 10n]);
    expect(allocated).toEqual([400n, 100n]);
  });

  it('份额合计超过被拆的金额时抛错，而不是悄悄多分', () => {
    expect(() => allocateProRata(1_000n, 100n, [60n, 60n])).toThrow(MoneyError);
  });

  it('分母为零时抛错——比例分摊在那里没有定义', () => {
    expect(() => allocateProRata(1_000n, 0n, [1n])).toThrow(MoneyError);
  });
});

describe('fxAdjustmentClientUuid', () => {
  const documentUuid = '9b5f7f0e-4a2c-4d7b-8a6e-2f1c0d3e5b71';

  it('同样的输入永远得到同样的值——作废时靠这个把调整凭证找回来', () => {
    expect(fxAdjustmentClientUuid(documentUuid, 'gain')).toBe(
      fxAdjustmentClientUuid(documentUuid, 'gain'),
    );
  });

  it('两种方向、以及与单据自己那一笔，三者互不相同', () => {
    const gain = fxAdjustmentClientUuid(documentUuid, 'gain');
    const loss = fxAdjustmentClientUuid(documentUuid, 'loss');

    expect(new Set([gain, loss, documentUuid]).size).toBe(3);
  });

  it('形状是一个合法的 v5 uuid —— client_uuid 列是 uuid 类型', () => {
    for (const kind of FX_RESULT_KINDS) {
      expect(fxAdjustmentClientUuid(documentUuid, kind)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});
