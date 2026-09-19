import { describe, expect, it } from 'vitest';
import { LedgerError } from '@/server/domain/ledger';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import { templateFor } from '@/server/domain/posting-templates';
import {
  applicationClientUuid,
  applicationPostingEvent,
  depositLegClientUuid,
  depositPostingEvent,
  MAX_PREPAYMENT_APPLICATIONS,
  PREPAYMENT_ACCOUNT_CODE,
  prepaymentClientUuid,
  splitPaymentLegs,
} from '@/server/services/prepayment';

/**
 * 预收 / 预付款的纯函数部分。
 *
 * 这一组不碰数据库，测的是最容易写错又最看不出来的那两件事：
 * **方向**（谁借谁贷）与**可加性**（两条腿各自换算 vs 整笔换算）。
 *
 * 方向写反不会有任何报错——一借一贷照样配平，科目归属校验照样通过，
 * 只是每一笔定金都记反了。这正是本项目历史上出过的那类 bug 的形状。
 */

const BANK = 'account-bank';
const DEPOSIT = 'account-deposit';
const CONTROL = 'account-control';

/** 把事件过一遍真正的模板，断言读起来就是一张丁字账。 */
function shape(event: Parameters<typeof templateFor>[0]): string[] {
  return templateFor(event).map((line) => `${line.direction}:${line.accountId}:${line.amountMinor}`);
}

describe('预收 / 预付挂账的方向', () => {
  it('收到定金：借资金账户 / 贷预收账款', () => {
    // 钱进了银行（资产增加），同时欠客户一批货（负债增加）。
    expect(
      shape(
        depositPostingEvent({
          direction: 'received',
          moneyAccountId: BANK,
          depositAccountId: DEPOSIT,
          amountMinor: 50_000n,
        }),
      ),
    ).toEqual([`debit:${BANK}:50000`, `credit:${DEPOSIT}:50000`]);
  });

  it('付出定金：借预付账款 / 贷资金账户', () => {
    // 完全的镜像：钱出了银行，换来供应商欠的一批货。
    expect(
      shape(
        depositPostingEvent({
          direction: 'made',
          moneyAccountId: BANK,
          depositAccountId: DEPOSIT,
          amountMinor: 50_000n,
        }),
      ),
    ).toEqual([`debit:${DEPOSIT}:50000`, `credit:${BANK}:50000`]);
  });

  it('两个方向互为镜像', () => {
    const args = { moneyAccountId: BANK, depositAccountId: DEPOSIT, amountMinor: 1_234n };
    const received = templateFor(depositPostingEvent({ direction: 'received', ...args }));
    const made = templateFor(depositPostingEvent({ direction: 'made', ...args }));

    const flip = (d: string) => (d === 'debit' ? 'credit' : 'debit');
    expect(made.map((l) => `${l.direction}:${l.accountId}`).sort()).toEqual(
      received.map((l) => `${flip(l.direction)}:${l.accountId}`).sort(),
    );
  });
});

describe('核销到单据的方向', () => {
  it('收款侧：借预收账款 / 贷应收账款', () => {
    expect(
      shape(
        applicationPostingEvent({
          direction: 'received',
          depositAccountId: DEPOSIT,
          controlAccountId: CONTROL,
          amountMinor: 30_000n,
        }),
      ),
    ).toEqual([`debit:${DEPOSIT}:30000`, `credit:${CONTROL}:30000`]);
  });

  it('付款侧：借应付账款 / 贷预付账款', () => {
    expect(
      shape(
        applicationPostingEvent({
          direction: 'made',
          depositAccountId: DEPOSIT,
          controlAccountId: CONTROL,
          amountMinor: 30_000n,
        }),
      ),
    ).toEqual([`debit:${CONTROL}:30000`, `credit:${DEPOSIT}:30000`]);
  });

  it('核销碰的是控制科目，不是收入或费用', () => {
    // 收入在开票那一刻就已经确认过了。核销时再碰一次损益表就是重复计算——
    // 客户付一次钱，账上出现两次收入，而两笔分录各自都配平。
    const lines = templateFor(
      applicationPostingEvent({
        direction: 'received',
        depositAccountId: DEPOSIT,
        controlAccountId: CONTROL,
        amountMinor: 1n,
      }),
    );
    expect(lines.map((l) => l.accountId).sort()).toEqual([CONTROL, DEPOSIT].sort());
  });
});

describe('挂账科目的选择', () => {
  it('收款挂负债、付款挂资产', () => {
    // 收了钱还没交付 = 欠客户的债；付了钱还没收货 = 供应商欠你的。
    expect(PREPAYMENT_ACCOUNT_CODE.received).toBe('customer-deposits');
    expect(PREPAYMENT_ACCOUNT_CODE.made).toBe('supplier-deposits');
  });
});

describe('splitPaymentLegs', () => {
  const base = { currency: 'MYR', baseCurrency: 'MYR', scaledRate: RATE_SCALE };

  it('全部核销时没有预收腿', () => {
    const legs = splitPaymentLegs({ amountMinor: 100_000n, itemAmounts: [60_000n, 40_000n], ...base });
    expect(legs.appliedMinor).toBe(100_000n);
    expect(legs.unappliedMinor).toBe(0n);
    expect(legs.baseAmountMinor).toBe(100_000n);
  });

  it('一张单据都不核销时整笔进预收腿', () => {
    const legs = splitPaymentLegs({ amountMinor: 100_000n, itemAmounts: [], ...base });
    expect(legs.appliedMinor).toBe(0n);
    expect(legs.unappliedMinor).toBe(100_000n);
  });

  it('部分核销时两条腿加起来等于整笔', () => {
    const legs = splitPaymentLegs({ amountMinor: 100_000n, itemAmounts: [30_000n], ...base });
    expect(legs.appliedMinor + legs.unappliedMinor).toBe(100_000n);
    expect(legs.appliedBaseMinor + legs.unappliedBaseMinor).toBe(legs.baseAmountMinor);
  });

  it('核销超过这笔款本身就报错', () => {
    expect(() =>
      splitPaymentLegs({ amountMinor: 100_000n, itemAmounts: [60_000n, 60_000n], ...base }),
    ).toThrow(LedgerError);
  });

  it('金额为零或负数就报错', () => {
    expect(() => splitPaymentLegs({ amountMinor: 0n, itemAmounts: [], ...base })).toThrow(LedgerError);
    expect(() => splitPaymentLegs({ amountMinor: -1n, itemAmounts: [], ...base })).toThrow(LedgerError);
  });

  it('外币：baseAmountMinor 是两条腿之和，不是整笔再换算一次', () => {
    // 半进位不可加。取一个会让两者真的差一分的组合：
    // 汇率 4.505，applied=3333 → 15015（15014.865 进位），
    // unapplied=6667 → 30035（30034.835 进位），合计 45050；
    // 而整笔 10000 一次换算是 45050——这一组恰好相等，所以再挑一组。
    const legs = splitPaymentLegs({
      amountMinor: 10_001n,
      itemAmounts: [3_333n],
      currency: 'USD',
      baseCurrency: 'MYR',
      scaledRate: 450_500_000n, // 4.505
    });

    expect(legs.appliedMinor + legs.unappliedMinor).toBe(10_001n);
    // 这一条是这个函数存在的理由：写进 payments.base_amount_minor 的必须是
    // 两条腿之和，因为总账里实际躺着的正是这两笔各自换算的结果。取「整笔
    // 换算一次」的话，payments 上那一列与总账就永远差着那一分，而没有任何
    // 页面能解释这一分是什么。
    expect(legs.baseAmountMinor).toBe(legs.appliedBaseMinor + legs.unappliedBaseMinor);
  });

  it('零小数币种（JPY）不被当成两位小数处理', () => {
    const legs = splitPaymentLegs({
      amountMinor: 10_000n, // 10,000 日元
      itemAmounts: [4_000n],
      currency: 'JPY',
      baseCurrency: 'MYR',
      scaledRate: 2_871_000n, // 0.02871
    });
    expect(legs.appliedMinor).toBe(4_000n);
    expect(legs.unappliedMinor).toBe(6_000n);
    expect(legs.baseAmountMinor).toBe(legs.appliedBaseMinor + legs.unappliedBaseMinor);
  });
});

describe('派生的幂等键', () => {
  const parent = '11111111-2222-4333-8444-555555555555';

  it('是确定性的——同样的输入永远得到同一个键', () => {
    expect(prepaymentClientUuid(parent, 'deposit')).toBe(prepaymentClientUuid(parent, 'deposit'));
    expect(applicationClientUuid(parent, 3)).toBe(applicationClientUuid(parent, 3));
  });

  it('不同用途、不同序号各不相同，也都不等于父键', () => {
    const keys = new Set([
      parent,
      depositLegClientUuid(parent),
      ...Array.from({ length: 8 }, (_, i) => applicationClientUuid(parent, i)),
    ]);
    // 1 个父键 + 1 条预收腿 + 8 次核销 = 10 个互不相同的键。撞号意味着
    // postJournal 的幂等查询会把一笔新分录当成重放直接跳过——账少记一笔，
    // 而且没有任何报错。
    expect(keys.size).toBe(10);
  });

  it('形状是合法的 uuid', () => {
    expect(depositLegClientUuid(parent)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(applicationClientUuid(parent, 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('父键不同则派生键也不同', () => {
    const other = '99999999-8888-4777-8666-555555555555';
    expect(depositLegClientUuid(parent)).not.toBe(depositLegClientUuid(other));
  });

  it('核销次数有上限，而且是个够大的数', () => {
    // 上限只是反过账时逐个探查的兜底，不该低到挡住正常使用。
    expect(MAX_PREPAYMENT_APPLICATIONS).toBeGreaterThanOrEqual(16);
  });
});
