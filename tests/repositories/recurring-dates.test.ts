import { describe, expect, it } from 'vitest';
import { computeNextDueDate } from '@/server/repositories/recurring';

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
