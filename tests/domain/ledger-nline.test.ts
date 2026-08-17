import { describe, expect, it } from 'vitest';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import {
  LedgerError,
  assertBalanced,
  assertLineInvariants,
  buildCheckedLines,
  buildLines,
} from '@/server/domain/ledger';

const A = 'acc-a';
const B = 'acc-b';
const C = 'acc-c';
const D = 'acc-d';

describe('buildLines - n lines', () => {
  it('builds a three-line invoice shape and balances', () => {
    const lines = buildLines(
      [
        { accountId: A, direction: 'debit', amountMinor: 10600n },
        { accountId: B, direction: 'credit', amountMinor: 10000n },
        { accountId: C, direction: 'credit', amountMinor: 600n },
      ],
      { currency: 'MYR', baseCurrency: 'MYR', scaledRate: RATE_SCALE },
    );

    expect(lines).toHaveLength(3);
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('rejects specs that do not balance in the original currency', () => {
    expect(() =>
      buildLines(
        [
          { accountId: A, direction: 'debit', amountMinor: 10000n },
          { accountId: B, direction: 'credit', amountMinor: 9999n },
        ],
        { currency: 'MYR', baseCurrency: 'MYR', scaledRate: RATE_SCALE },
      ),
    ).toThrow(LedgerError);
  });

  it('rejects fewer than two lines', () => {
    expect(() =>
      buildLines([{ accountId: A, direction: 'debit', amountMinor: 100n }], {
        currency: 'MYR',
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
      }),
    ).toThrow(LedgerError);
  });

  it('absorbs a rounding difference into the largest line, keeping base amounts balanced', () => {
    // Debit 5, credits 3 (largest, listed FIRST) and 2 (smaller, listed LAST).
    // Independent per-line conversion at this rate gives debit -> 24,
    // credit B(3) -> 14, credit C(2) -> 9. Credits sum to 23 against a debit
    // of 24: a genuine one-cent gap on the credit side. B is both the
    // largest credit line and NOT the last line in the specs array, so this
    // input can distinguish "adjust the largest line" from "adjust the last
    // line" -- an input where the largest line happens to also be last
    // cannot tell the two apart.
    const lines = buildLines(
      [
        { accountId: A, direction: 'debit', amountMinor: 5n },
        { accountId: B, direction: 'credit', amountMinor: 3n },
        { accountId: C, direction: 'credit', amountMinor: 2n },
      ],
      { currency: 'USD', baseCurrency: 'MYR', scaledRate: 4_71834900n },
    );

    expect(() => assertBalanced(lines)).not.toThrow();

    const debit = lines.find((l) => l.accountId === A)!;
    const largestCredit = lines.find((l) => l.accountId === B)!;
    const otherCredit = lines.find((l) => l.accountId === C)!;

    const exact = (amount: bigint) => (amount * 4_71834900n * 2n + RATE_SCALE) / (RATE_SCALE * 2n);

    // The debit side was already balanced on its own; its single line is untouched.
    expect(debit.baseAmountMinor).toBe(exact(5n));
    // The smaller, last-listed credit line equals its own independent conversion.
    expect(otherCredit.baseAmountMinor).toBe(exact(2n));
    // The larger, first-listed credit line absorbs the one-cent gap.
    expect(largestCredit.baseAmountMinor).toBe(exact(3n) + 1n);
  });

  // 这一条量的是 buildLines 与 assertLineInvariants 的配合，而不是任一方
  // 自己。post-journal.ts 里这两个函数背靠背调用：上一句故意让一行偏离自己
  // 的换算结果，下一句去核对每一行。原来这个用例挂着同样的标题，喂进去的
  // 却是 SGD 100 @ 3.5 —— 残差恒为 0，吸收分支根本不执行，于是"除被调整的
  // 那一行之外"这句话从没被验证过，两个函数互斥了整整一个分支也照样全绿。
  //
  // 四行、残差为 1，且最大的那一行既不是第一行也不是最后一行：
  //   借 12 -> 57；贷 2 -> 9、8 -> 38、2 -> 9，合计 56。
  // 差 1 落在贷方，短边最大的是 C（8），被调成 39。
  it('produces lines that assertLineInvariants accepts, with the adjustment on the largest line', () => {
    const RATE = 4_71834900n;
    const exact = (amount: bigint) => (amount * RATE * 2n + RATE_SCALE) / (RATE_SCALE * 2n);
    const ctx = { currency: 'USD', baseCurrency: 'MYR', scaledRate: RATE };

    const lines = buildLines(
      [
        { accountId: A, direction: 'debit', amountMinor: 12n },
        { accountId: B, direction: 'credit', amountMinor: 2n },
        { accountId: C, direction: 'credit', amountMinor: 8n },
        { accountId: D, direction: 'credit', amountMinor: 2n },
      ],
      ctx,
    );

    // 残差确实非零：如果这里等于 exact(8n)，说明这组输入根本没触发吸收，
    // 下面那句 not.toThrow 就又成了一句什么也没证明的话。
    expect(lines[2].baseAmountMinor).toBe(exact(8n) + 1n);
    expect(exact(12n)).not.toBe(exact(2n) + exact(8n) + exact(2n));

    // 被调整的必须是最大的那一行（C），不是最后一行（D），也不是第一行（B）。
    expect(lines[0].baseAmountMinor).toBe(exact(12n));
    expect(lines[1].baseAmountMinor).toBe(exact(2n));
    expect(lines[3].baseAmountMinor).toBe(exact(2n));

    // 而这正是边界下一句要做的事：吸收之后的这组行必须通过行级不变量。
    expect(() => assertLineInvariants(lines, { ...ctx, rateSource: 'auto' })).not.toThrow();
  });
});

/**
 * 上面那些用例喂的是 buildLines，然后各自再调一次 assertLineInvariants。
 * 这一组喂的是 buildCheckedLines —— post-journal.ts 的 buildValidatedLines
 * 逐字调用的那一个函数，也就是每一笔记账真正走的那两步。区别不在断言，
 * 在于测的是不是同一段代码：手抄一遍「先 build 再 assert」的顺序，量到的
 * 只是这份手抄，边界那边改成别的顺序也照样全绿。
 *
 * 三行外币分录是阶段 4 要记的第一种形状（发票：借应收 / 贷收入 / 贷销项税），
 * 也正是原来 I3 会误判的那一种。
 */
describe('buildCheckedLines - the pair the posting boundary calls', () => {
  const RATE = 4_71834900n; // USD -> MYR
  const ctx = {
    currency: 'USD',
    baseCurrency: 'MYR',
    scaledRate: RATE,
    rateSource: 'auto' as const,
  };
  const exact = (amount: bigint) => (amount * RATE * 2n + RATE_SCALE) / (RATE_SCALE * 2n);

  // USD 106.11 = 100.10 净额 + 6.01 销项税。逐行换算：
  //   借 10611 -> 50066；贷 10010 -> 47231、601 -> 2836，合计 50067。
  // 借方短 1，短边只有一行，那 1 落在借方——与上面几条落在贷方的用例互补。
  const INVOICE = [
    { accountId: A, direction: 'debit' as const, amountMinor: 10611n },
    { accountId: B, direction: 'credit' as const, amountMinor: 10010n },
    { accountId: C, direction: 'credit' as const, amountMinor: 601n },
  ];

  it('accepts a three-line foreign-currency invoice whose per-line rounding leaves a residual', () => {
    // 先确认这组输入真的有残差。没有残差的话，下面那句 not.toThrow 通不过
    // 也证明不了什么——这正是本文件里已经修过一次的那种空用例。
    expect(exact(10611n)).not.toBe(exact(10010n) + exact(601n));

    const lines = buildCheckedLines(INVOICE, ctx);

    expect(lines).toHaveLength(3);
    // 借方那一行吸收了残差，于是它不等于自己的换算结果。postJournal 拿
    // lines[0].baseAmountMinor 当交易表头的本位币金额，所以表头记的是吸收
    // 之后的 50067，与分录借方合计一致——而不是 50066。
    expect(lines[0].baseAmountMinor).toBe(exact(10611n) + 1n);
    expect(lines[1].baseAmountMinor).toBe(exact(10010n));
    expect(lines[2].baseAmountMinor).toBe(exact(601n));
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('still refuses a foreign posting at an automatic rate of exactly 1', () => {
    // I4 没有因为这次合并而丢掉：它在同一个函数里，与 I3 一起跑。
    expect(() =>
      buildCheckedLines(
        [
          { accountId: A, direction: 'debit', amountMinor: 10611n },
          { accountId: B, direction: 'credit', amountMinor: 10611n },
        ],
        { ...ctx, scaledRate: RATE_SCALE },
      ),
    ).toThrow(LedgerError);
  });

  it('still refuses specs that do not balance in the original currency', () => {
    expect(() =>
      buildCheckedLines(
        [
          { accountId: A, direction: 'debit', amountMinor: 10611n },
          { accountId: B, direction: 'credit', amountMinor: 10010n },
          { accountId: C, direction: 'credit', amountMinor: 600n },
        ],
        ctx,
      ),
    ).toThrow(LedgerError);
  });
});
