import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenarioById } from '@/server/domain/scenario';

describe('scenario definitions', () => {
  it('money-in is income and requires category selection', () => {
    const s = scenarioById('money-in')!;
    expect(s.kind).toBe('income');
    expect(s.defaultAccountCode).toBeNull();
    expect(s.needsCategory).toBe(true);
  });

  it('money-out is expense and requires category selection', () => {
    const s = scenarioById('money-out')!;
    expect(s.kind).toBe('expense');
    expect(s.defaultAccountCode).toBeNull();
    expect(s.needsCategory).toBe(true);
  });

  it('buy-stock is expense, preselects purchases account, and needs no category', () => {
    const s = scenarioById('buy-stock')!;
    expect(s.kind).toBe('expense');
    expect(s.defaultAccountCode).toBe('purchases');
    expect(s.needsCategory).toBe(false);
  });

  it('move-money is transfer and needs no category', () => {
    const s = scenarioById('move-money')!;
    expect(s.kind).toBe('transfer');
    expect(s.defaultAccountCode).toBeNull();
    expect(s.needsCategory).toBe(false);
  });

  it('not-sure posts as a journal to suspense without requiring a category', () => {
    const s = scenarioById('not-sure')!;
    expect(s.kind).toBe('journal');
    expect(s.defaultAccountCode).toBe('suspense');
    expect(s.needsCategory).toBe(false);
  });

  it('returns undefined for an unknown id', () => {
    expect(scenarioById('nope')).toBeUndefined();
  });
});
