import { describe, expect, it } from 'vitest';
import { reconciliationSummary } from '@/server/domain/reconciliation';

/**
 * 对账的那条恒等式。
 *
 * 这一组测试的存在本身就是修复的一部分：这条式子原来写在 React 组件里，
 * 写错了没有任何东西会红。它当时错成这样——
 *
 *     difference = 对账单余额 - (账面余额 + 调整)
 *
 * ——差额与「勾了哪几笔」完全无关，而「完成对账」的按钮被 difference !== 0
 * 锁着。于是只要有一笔交易还没在银行那边清掉，这一页就永远走不完。
 *
 * 下面第一条用例就是按那个场景写的：它在旧算式下必然失败。
 */

/** 只给必要的字段，其余取中性值。 */
function summary(input: {
  book: bigint;
  unreconciled: bigint[];
  cleared: bigint[];
  adjustment?: bigint;
  statement: bigint;
}) {
  return reconciliationSummary({
    bookBalanceMinor: input.book,
    unreconciledEffects: input.unreconciled,
    clearedEffects: input.cleared,
    adjustmentMinor: input.adjustment ?? 0n,
    statementBalanceMinor: input.statement,
  });
}

describe('reconciliationSummary', () => {
  it('手上还有一张没兑现的支票时，对账依然能对平', () => {
    // 账面 1,000。其中一笔 -200 的付款银行还没清掉，另一笔 +500 的收款清了。
    // 以前各期已对完的余额 = 1000 - (500 - 200) = 700。
    // 银行现在应该是 700 + 500 = 1,200。
    const result = summary({
      book: 100_000n,
      unreconciled: [50_000n, -20_000n],
      cleared: [50_000n],
      statement: 120_000n,
    });

    expect(result.priorBalanceMinor).toBe(70_000n);
    expect(result.clearedMinor).toBe(50_000n);
    expect(result.expectedBalanceMinor).toBe(120_000n);
    // 旧算式在这里会得到 120000 - 100000 = 20000，永远归不了零。
    expect(result.differenceMinor).toBe(0n);
  });

  it('勾选会改变差额——这正是旧算式没有做到的那一件事', () => {
    const args = { book: 100_000n, unreconciled: [50_000n, -20_000n], statement: 120_000n };

    const none = summary({ ...args, cleared: [] });
    const one = summary({ ...args, cleared: [50_000n] });

    expect(none.differenceMinor).not.toBe(one.differenceMinor);
    expect(none.differenceMinor).toBe(50_000n);
  });

  it('把每一笔都勾上时，推算值就回到账面余额', () => {
    const result = summary({
      book: 100_000n,
      unreconciled: [50_000n, -20_000n],
      cleared: [50_000n, -20_000n],
      statement: 100_000n,
    });

    expect(result.expectedBalanceMinor).toBe(100_000n);
    expect(result.differenceMinor).toBe(0n);
  });

  it('一笔未对账交易都没有时，对账单应当等于账面余额', () => {
    const result = summary({ book: 100_000n, unreconciled: [], cleared: [], statement: 100_000n });

    expect(result.priorBalanceMinor).toBe(100_000n);
    expect(result.differenceMinor).toBe(0n);
  });

  it('调整项按符号计入：银行手续费是负的', () => {
    // 银行收了 10.00 手续费，账上还没记。勾上那笔清掉的收款并填 -10.00。
    const result = summary({
      book: 100_000n,
      unreconciled: [50_000n],
      cleared: [50_000n],
      adjustment: -1_000n,
      statement: 99_000n,
    });

    expect(result.clearedMinor).toBe(49_000n);
    expect(result.differenceMinor).toBe(0n);
  });

  it('对账单余额可以是负数（透支）', () => {
    const result = summary({
      book: -30_000n,
      unreconciled: [-20_000n],
      cleared: [-20_000n],
      statement: -30_000n,
    });

    expect(result.priorBalanceMinor).toBe(-10_000n);
    expect(result.differenceMinor).toBe(0n);
  });

  it('差额的符号说明缺口在哪一边', () => {
    const base = { book: 100_000n, unreconciled: [50_000n], cleared: [50_000n] };

    // 银行比账上多：对账单余额大于推算值，差额为正。
    expect(summary({ ...base, statement: 100_500n }).differenceMinor).toBe(500n);
    // 银行比账上少。
    expect(summary({ ...base, statement: 99_500n }).differenceMinor).toBe(-500n);
  });

  it('全程 bigint：数额大到 Number 会丢精度也不出错', () => {
    // 2^53 之上。用 number 存最小单位时，这两个数会在加法里塌成同一个值。
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const result = summary({
      book: huge,
      unreconciled: [1n],
      cleared: [1n],
      statement: huge,
    });

    expect(result.priorBalanceMinor).toBe(huge - 1n);
    expect(result.differenceMinor).toBe(0n);
  });
});
