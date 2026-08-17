import { describe, expect, it } from 'vitest';
import { LedgerError } from '@/server/domain/ledger';
import {
  computeNextDueDate,
  plannedDueDates,
  MAX_CATCH_UP_PER_RULE,
} from '@/server/repositories/recurring';

// 纯函数，不碰数据库。
//
// 改之前这里用的是 d.setMonth(d.getMonth() + interval)：2026-01-31 加一个月，
// 二月没有 31 号，JavaScript 直接溢出到 2026-03-03。以前一次生成只推进一期，
// 这个漂移一年才现一次形；接上补记之后，每一期都会重新踩，误差逐期累积。

describe('computeNextDueDate - 日与周', () => {
  it('按天推进，跨月跨年都不出错', () => {
    expect(computeNextDueDate('daily', 1, '2026-02-28')).toBe('2026-03-01');
    expect(computeNextDueDate('daily', 1, '2026-12-31')).toBe('2027-01-01');
    expect(computeNextDueDate('daily', 10, '2026-03-25')).toBe('2026-04-04');
  });

  it('闰年的 2 月 28 日的下一天是 29 日', () => {
    expect(computeNextDueDate('daily', 1, '2028-02-28')).toBe('2028-02-29');
    expect(computeNextDueDate('daily', 1, '2028-02-29')).toBe('2028-03-01');
  });

  it('按周推进', () => {
    expect(computeNextDueDate('weekly', 1, '2026-01-29')).toBe('2026-02-05');
    expect(computeNextDueDate('weekly', 2, '2026-12-24')).toBe('2027-01-07');
  });
});

describe('computeNextDueDate - 月末夹取', () => {
  it('1 月 31 日加一个月落在 2 月的最后一天，而不是溢出到 3 月', () => {
    expect(computeNextDueDate('monthly', 1, '2026-01-31')).toBe('2026-02-28');
    // 旧写法给出的答案，明确钉住不再回归。
    expect(computeNextDueDate('monthly', 1, '2026-01-31')).not.toBe('2026-03-03');
  });

  it('闰年 2 月有 29 天，夹到 29 而不是 28', () => {
    expect(computeNextDueDate('monthly', 1, '2028-01-31')).toBe('2028-02-29');
  });

  it('31 日加一个月落在 30 天的月份时夹到 30', () => {
    expect(computeNextDueDate('monthly', 1, '2026-03-31')).toBe('2026-04-30');
    expect(computeNextDueDate('monthly', 1, '2026-05-31')).toBe('2026-06-30');
  });

  it('日期够小的月份原样加，不受夹取影响', () => {
    expect(computeNextDueDate('monthly', 1, '2026-01-15')).toBe('2026-02-15');
    expect(computeNextDueDate('monthly', 1, '2026-12-15')).toBe('2027-01-15');
  });

  it('interval 大于 1 时同样夹取', () => {
    expect(computeNextDueDate('monthly', 2, '2026-12-31')).toBe('2027-02-28');
    expect(computeNextDueDate('monthly', 13, '2026-01-31')).toBe('2027-02-28');
  });
});

describe('computeNextDueDate - 季与年', () => {
  it('季度同样夹到目标月的最后一天', () => {
    expect(computeNextDueDate('quarterly', 1, '2026-08-31')).toBe('2026-11-30');
    expect(computeNextDueDate('quarterly', 1, '2025-11-30')).toBe('2026-02-28');
    expect(computeNextDueDate('quarterly', 2, '2026-02-28')).toBe('2026-08-28');
  });

  it('闰日加一年落在 2 月 28 日，而不是 3 月 1 日', () => {
    expect(computeNextDueDate('yearly', 1, '2028-02-29')).toBe('2029-02-28');
    expect(computeNextDueDate('yearly', 1, '2028-02-29')).not.toBe('2029-03-01');
  });

  it('闰日加四年回到闰日', () => {
    expect(computeNextDueDate('yearly', 4, '2028-02-29')).toBe('2032-02-29');
  });

  it('非闰日的年推进就是同月同日', () => {
    expect(computeNextDueDate('yearly', 1, '2026-07-04')).toBe('2027-07-04');
  });
});

describe('computeNextDueDate - 连续推进', () => {
  it('从 1 月 31 日连走 12 期，每一期都是合法日期且落在预期的月份里', () => {
    // 关键的回归点：旧写法从 2026-01-31 走 12 期会一路漂到别的月份去
    // （2026-03-03 -> 2026-04-03 -> ...），走满一年后连月份都对不上。
    //
    // 下面这串期望值里的「粘性」是**选定的行为，不是实现顺手的产物**，改动
    // 它需要先想清楚下面这段：computeNextDueDate 只看得见当前这一期的日期，
    // 所以 1 月 31 日夹到 2 月 28 日之后，就一直停在 28 号，不会在 3 月弹回
    // 31 号。要弹回去，就得改成以 start_date 的「几号」为锚、按第 N 期直接
    // 算出日期，那是另一个函数、另一套签名。
    //
    // 之所以可以先不改：粘性从不把某一期挪出它该在的那个月份——每个频率都
    // 一样——所以任何一期落在哪个会计期间、金额是多少，都不受影响；受影响
    // 的只是月内的第几天。而旧写法的溢出是会换月份的，那才是必须先修的那个。
    // 换句话说，这串期望值是有意钉住的，不是「跑出来是什么就写什么」。
    const expected = [
      '2026-02-28',
      '2026-03-28',
      '2026-04-28',
      '2026-05-28',
      '2026-06-28',
      '2026-07-28',
      '2026-08-28',
      '2026-09-28',
      '2026-10-28',
      '2026-11-28',
      '2026-12-28',
      '2027-01-28',
    ];

    let cursor = '2026-01-31';
    const walked: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      cursor = computeNextDueDate('monthly', 1, cursor);
      walked.push(cursor);
    }

    expect(walked).toEqual(expected);
  });

  it('每日规则连走一年，日期严格递增且不重复', () => {
    let cursor = '2027-12-20';
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const next = computeNextDueDate('daily', 1, cursor);
      expect(next > cursor).toBe(true);
      expect(seen.has(next)).toBe(false);
      seen.add(next);
      cursor = next;
    }
    // 2027-12-20 起 400 天，跨过 2028 这个闰年。
    expect(cursor).toBe('2029-01-23');
  });
});

// plannedDueDates 同样是纯函数。这些用例刻意不碰数据库：interval = 0 这条
// 断言原本活在一个集成用例里，那个用例必须先把 "interval" = 0 的行插进库，
// 而 0019 迁移加上 check ("interval" >= 1) 之后，CHECK 约束对所有角色生效
// （RLS 可以用超级用户绕过，CHECK 不能），fixture 会在断言之前就炸。搬到
// 这里之后，这道防线的覆盖在迁移落地后依然成立。
describe('plannedDueDates', () => {
  function rule(fields: {
    frequency?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
    interval?: number;
    nextDueDate: string;
    endDate?: string | null;
  }) {
    return {
      frequency: fields.frequency ?? 'monthly',
      interval: fields.interval ?? 1,
      nextDueDate: fields.nextDueDate,
      endDate: fields.endDate ?? null,
    } as const;
  }

  it('列出从 next_due_date 到今天为止的每一期', () => {
    expect(plannedDueDates(rule({ nextDueDate: '2026-03-15' }), '2026-06-01')).toEqual([
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
    ]);
  });

  it('今天刚好到期时只列这一期', () => {
    expect(plannedDueDates(rule({ nextDueDate: '2026-06-01' }), '2026-06-01')).toEqual([
      '2026-06-01',
    ]);
  });

  it('不越过 end_date，即使 end_date 早已过去', () => {
    expect(
      plannedDueDates(rule({ nextDueDate: '2026-03-15', endDate: '2026-05-15' }), '2026-12-31'),
    ).toEqual(['2026-03-15', '2026-04-15', '2026-05-15']);
  });

  it('单次最多补 MAX_CATCH_UP_PER_RULE 期', () => {
    const dates = plannedDueDates(
      rule({ frequency: 'daily', nextDueDate: '2026-01-01' }),
      '2026-12-31',
    );
    expect(dates).toHaveLength(MAX_CATCH_UP_PER_RULE);
    expect(dates[0]).toBe('2026-01-01');
    expect(dates[MAX_CATCH_UP_PER_RULE - 1]).toBe('2026-03-01');
  });

  it('间隔为 0 时抛错，而不是把同一天列 60 遍', () => {
    // 这是把 RM1,200 的房租变成 RM72,000 的那条路径：computeNextDueDate 在
    // interval = 0 时五个分支全是恒等函数，游标不动，循环把同一天填满上限，
    // 每笔一个新的 clientUuid 所以幂等拦不住，写回的 next_due_date 又没变，
    // 于是再点一次再来一批——而借贷完全配平，配平触发器什么也看不见。
    for (const frequency of ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const) {
      expect(() =>
        plannedDueDates(rule({ frequency, interval: 0, nextDueDate: '2026-03-01' }), '2026-06-01'),
      ).toThrow(/at least 1/i);
    }
  });

  it('间隔为负数时同样抛错', () => {
    expect(() =>
      plannedDueDates(rule({ interval: -1, nextDueDate: '2026-03-01' }), '2026-06-01'),
    ).toThrow(LedgerError);
  });

  it('还没到期的规则一期都不列', () => {
    expect(plannedDueDates(rule({ nextDueDate: '2027-01-01' }), '2026-06-01')).toEqual([]);
    // 游标已经越过 end_date 的规则同理——getDueRecurring 的 where 子句本来就
    // 会把它挡在外面，这里是同一条判断的第二道。
    expect(
      plannedDueDates(rule({ nextDueDate: '2026-06-15', endDate: '2026-05-15' }), '2026-12-31'),
    ).toEqual([]);
  });
});
