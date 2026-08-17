import { describe, expect, it } from 'vitest';
import {
  PeriodLockedError,
  assertPeriodOpen,
  isDateLocked,
} from '@/server/domain/period-lock';

describe('isDateLocked', () => {
  it('treats everything as open when no lock is set', () => {
    expect(isDateLocked('2020-01-01', null)).toBe(false);
  });

  it('locks dates before the lock date', () => {
    expect(isDateLocked('2026-06-30', '2026-07-31')).toBe(true);
  });

  it('locks the lock date itself', () => {
    expect(isDateLocked('2026-07-31', '2026-07-31')).toBe(true);
  });

  it('leaves dates after the lock date open', () => {
    expect(isDateLocked('2026-08-01', '2026-07-31')).toBe(false);
  });

  it('rejects malformed dates', () => {
    expect(() => isDateLocked('31/07/2026', '2026-07-31')).toThrow(PeriodLockedError);
    expect(() => isDateLocked('2026-07-31', '2026-7-31')).toThrow(PeriodLockedError);
  });
});

describe('assertPeriodOpen', () => {
  it('passes for an open period', () => {
    expect(() => assertPeriodOpen('2026-08-01', '2026-07-31', 'owner')).not.toThrow();
  });

  it('throws for a locked period', () => {
    expect(() => assertPeriodOpen('2026-07-15', '2026-07-31', 'owner')).toThrow(PeriodLockedError);
  });

  /**
   * 这两条量的是提示语指的那个动作，这个角色做不做得到。
   *
   * period:lock 只有 owner 有（permissions.ts 的 MATRIX）。这句话原来对所有
   * 角色都写「Unlock the period」——admin 和 bookkeeper 读到的是一件他们
   * 点不开的事。本分支把折旧与定期补记接进了这个检查，非 owner 从此撞得到。
   */
  it('tells an owner to unlock the period, because an owner can', () => {
    expect(() => assertPeriodOpen('2026-07-15', '2026-07-31', 'owner')).toThrow(
      /Unlock the period before changing this record\./,
    );
  });

  it('tells everyone else who to ask, because they cannot unlock it themselves', () => {
    for (const role of ['admin', 'bookkeeper', 'viewer'] as const) {
      expect(() => assertPeriodOpen('2026-07-15', '2026-07-31', role)).toThrow(
        /Ask an owner to unlock the period/,
      );
      // 不能同时还留着那句让他自己去解锁的话。
      expect(() => assertPeriodOpen('2026-07-15', '2026-07-31', role)).not.toThrow(
        /Unlock the period before changing this record\./,
      );
    }
  });

  it('always names the date the books are locked through', () => {
    for (const role of ['owner', 'admin', 'bookkeeper', 'viewer'] as const) {
      expect(() => assertPeriodOpen('2026-07-15', '2026-07-31', role)).toThrow(
        /locked through 2026-07-31/,
      );
    }
  });
});
