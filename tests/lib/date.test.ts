import { describe, expect, it } from 'vitest';
import { addDaysLocalISO, addMonthsLocalISO, startOfLocalYear, todayLocalISO } from '@/lib/date';

/**
 * 这些函数替换掉的是散落在 12 个表单里的
 * `new Date().toISOString().slice(0, 10)`。
 *
 * toISOString() 先把时间转成 UTC 再格式化，所以对一个 UTC+8 的用户，每天
 * 00:00–08:00 这八小时里表单默认填的是**昨天**。日期不是排版问题：它决定
 * 这笔账落在哪个月的损益表，以及会不会撞上已封账的期间。
 */

/** 构造一个「本地时间是这一刻」的 Date，用来固定住测试。 */
function localDate(y: number, m: number, d: number, h = 0, min = 0): Date {
  return new Date(y, m - 1, d, h, min);
}

describe('todayLocalISO', () => {
  it('formats the local date parts, not the UTC ones', () => {
    // 本地 2026-03-01 00:30。在 UTC+8 下，这一刻的 UTC 是 2026-02-28 16:30，
    // 于是 toISOString().slice(0,10) 会给出 '2026-02-28' —— 上一个月。
    expect(todayLocalISO(localDate(2026, 3, 1, 0, 30))).toBe('2026-03-01');
  });

  it('pads single-digit months and days', () => {
    expect(todayLocalISO(localDate(2026, 1, 5))).toBe('2026-01-05');
  });

  it('is stable across the late-evening hours too', () => {
    // 另一侧的边界：本地 23:30。UTC-x 的时区下 toISOString 会给出明天。
    expect(todayLocalISO(localDate(2026, 12, 31, 23, 30))).toBe('2026-12-31');
  });
});

describe('addMonthsLocalISO', () => {
  it('clamps to the last day of the target month instead of overflowing', () => {
    // 这是替换掉的那段代码里真实存在的 bug：
    //   const d = new Date(); d.setMonth(d.getMonth() + 1);
    // JS 的 setMonth 在目标月没有这一天时往后溢出。1 月 31 日加一个月得到
    // 的是 3 月 3 日（2 月只有 28 天，多出的 3 天顺延）。一张 1 月 31 日开
    // 的月结发票，到期日会落在 3 月 3 日而不是 2 月 28 日 —— 账龄表少算一
    // 个桶，催收晚三天。
    expect(addMonthsLocalISO(1, localDate(2026, 1, 31))).toBe('2026-02-28');
  });

  it('clamps correctly in a leap year', () => {
    // 2028 是闰年，2 月有 29 天。
    expect(addMonthsLocalISO(1, localDate(2028, 1, 31))).toBe('2028-02-29');
  });

  it('keeps the day when the target month is long enough', () => {
    expect(addMonthsLocalISO(1, localDate(2026, 3, 15))).toBe('2026-04-15');
    expect(addMonthsLocalISO(1, localDate(2026, 1, 30))).toBe('2026-02-28');
    expect(addMonthsLocalISO(1, localDate(2026, 3, 31))).toBe('2026-04-30');
  });

  it('rolls over the year boundary', () => {
    expect(addMonthsLocalISO(1, localDate(2026, 12, 15))).toBe('2027-01-15');
    expect(addMonthsLocalISO(2, localDate(2026, 12, 31))).toBe('2027-02-28');
  });

  it('accepts a negative count', () => {
    expect(addMonthsLocalISO(-1, localDate(2026, 3, 31))).toBe('2026-02-28');
  });
});

describe('addDaysLocalISO', () => {
  it('crosses a month boundary', () => {
    expect(addDaysLocalISO(1, localDate(2026, 1, 31))).toBe('2026-02-01');
  });

  it('crosses a year boundary', () => {
    expect(addDaysLocalISO(30, localDate(2026, 12, 20))).toBe('2027-01-19');
  });

  it('handles February in a leap year', () => {
    expect(addDaysLocalISO(1, localDate(2028, 2, 28))).toBe('2028-02-29');
    expect(addDaysLocalISO(1, localDate(2026, 2, 28))).toBe('2026-03-01');
  });
});

describe('startOfLocalYear', () => {
  it('uses the local year', () => {
    // 本地 2027-01-01 00:30 —— UTC+8 下 UTC 仍是 2026 年。
    expect(startOfLocalYear(localDate(2027, 1, 1, 0, 30))).toBe('2027-01-01');
  });
});
