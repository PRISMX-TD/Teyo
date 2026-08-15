import { describe, expect, it } from 'vitest';
import {
  checkBalanceSheet,
  checkCashFlow,
  checkTrialBalance,
} from '@/server/domain/report-invariants';

describe('checkBalanceSheet (I5)', () => {
  it('reports balanced when assets equal liabilities plus equity plus current-year earnings', () => {
    const result = checkBalanceSheet({
      assetTotal: 150000n,
      liabilityTotal: 50000n,
      equityTotal: 80000n,
      currentYearEarnings: 20000n,
    });
    expect(result).toEqual({ balanced: true, differenceMinor: 0n });
  });

  it('reports the signed difference when it does not balance', () => {
    const result = checkBalanceSheet({
      assetTotal: 150000n,
      liabilityTotal: 50000n,
      equityTotal: 80000n,
      currentYearEarnings: 0n,
    });
    expect(result).toEqual({ balanced: false, differenceMinor: 20000n });
  });

  it('reports a negative difference when the right side is larger', () => {
    const result = checkBalanceSheet({
      assetTotal: 100000n,
      liabilityTotal: 50000n,
      equityTotal: 80000n,
      currentYearEarnings: 0n,
    });
    expect(result).toEqual({ balanced: false, differenceMinor: -30000n });
  });
});

describe('checkTrialBalance (I6)', () => {
  it('reports balanced when debits equal credits', () => {
    const result = checkTrialBalance([
      { debitMinor: 10000n, creditMinor: 0n },
      { debitMinor: 0n, creditMinor: 10000n },
    ]);
    expect(result).toEqual({ balanced: true, differenceMinor: 0n });
  });

  it('reports the difference when they do not', () => {
    const result = checkTrialBalance([
      { debitMinor: 10000n, creditMinor: 0n },
      { debitMinor: 0n, creditMinor: 9000n },
    ]);
    expect(result).toEqual({ balanced: false, differenceMinor: 1000n });
  });

  it('treats an empty report as balanced', () => {
    expect(checkTrialBalance([])).toEqual({ balanced: true, differenceMinor: 0n });
  });
});

describe('checkCashFlow (I8)', () => {
  it('reports balanced when opening plus net change equals closing', () => {
    const result = checkCashFlow({
      openingCash: 100000n,
      netChange: 25000n,
      closingCash: 125000n,
    });
    expect(result).toEqual({ balanced: true, differenceMinor: 0n });
  });

  it('reports the difference when the statement does not tie', () => {
    const result = checkCashFlow({
      openingCash: 100000n,
      netChange: 25000n,
      closingCash: 120000n,
    });
    expect(result).toEqual({ balanced: false, differenceMinor: 5000n });
  });
});
