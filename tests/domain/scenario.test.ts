import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenarioById } from '@/server/domain/scenario';

describe('scenario definitions', () => {
  it('every scenario maps onto an existing transaction kind', () => {
    for (const s of SCENARIOS) {
      expect(['income', 'expense', 'transfer']).toContain(s.kind);
    }
  });

  it('buy-stock preselects the purchases account and needs no category choice', () => {
    const s = scenarioById('buy-stock')!;
    expect(s.kind).toBe('expense');
    expect(s.defaultAccountCode).toBe('purchases');
    expect(s.needsCategory).toBe(false);
  });

  it('not-sure routes to the suspense account', () => {
    const s = scenarioById('not-sure')!;
    expect(s.defaultAccountCode).toBe('suspense');
    expect(s.needsCategory).toBe(false);
  });

  it('money-in and money-out require the user to pick a category', () => {
    expect(scenarioById('money-in')!.needsCategory).toBe(true);
    expect(scenarioById('money-out')!.needsCategory).toBe(true);
  });

  it('move-money is a transfer and needs no category', () => {
    const s = scenarioById('move-money')!;
    expect(s.kind).toBe('transfer');
    expect(s.needsCategory).toBe(false);
  });

  it('returns undefined for an unknown id', () => {
    expect(scenarioById('nope')).toBeUndefined();
  });
});
