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
    expect(() => assertPeriodOpen('2026-08-01', '2026-07-31')).not.toThrow();
  });

  it('throws for a locked period', () => {
    expect(() => assertPeriodOpen('2026-07-15', '2026-07-31')).toThrow(PeriodLockedError);
  });
});
