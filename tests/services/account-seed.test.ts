import { describe, expect, it } from 'vitest';
import { SEED_ACCOUNTS, SEED_CATEGORIES } from '@/server/services/account-seed';

describe('SEED_ACCOUNTS', () => {
  it('has unique codes', () => {
    const codes = SEED_ACCOUNTS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('covers all five account types', () => {
    const types = new Set(SEED_ACCOUNTS.map((a) => a.type));
    expect([...types].sort()).toEqual(['asset', 'equity', 'expense', 'liability', 'revenue']);
  });

  it('includes every account named in the spec', () => {
    const codes = SEED_ACCOUNTS.map((a) => a.code);
    for (const code of [
      'cash',
      'bank',
      'accounts-receivable',
      'inventory',
      'accounts-payable',
      'loans',
      'tax-payable',
      'capital',
      'retained-earnings',
      'owners-draw',
      'sales',
      'other-income',
      'rent',
      'salaries',
      'utilities',
      'marketing',
      'transport',
      'professional-fees',
      'other-expenses',
    ]) {
      expect(codes, code).toContain(code);
    }
  });

  it('marks only asset accounts as money accounts', () => {
    for (const account of SEED_ACCOUNTS.filter((a) => a.isMoneyAccount)) {
      expect(account.type).toBe('asset');
    }
  });

  it('marks cash and bank as money accounts', () => {
    expect(SEED_ACCOUNTS.find((a) => a.code === 'cash')?.isMoneyAccount).toBe(true);
    expect(SEED_ACCOUNTS.find((a) => a.code === 'bank')?.isMoneyAccount).toBe(true);
    expect(SEED_ACCOUNTS.find((a) => a.code === 'sales')?.isMoneyAccount).toBe(false);
  });

  it('provides both language names for every account', () => {
    for (const account of SEED_ACCOUNTS) {
      expect(account.nameEn.length, account.code).toBeGreaterThan(0);
      expect(account.nameZh.length, account.code).toBeGreaterThan(0);
    }
  });

  it('uses codes that satisfy the accountSchema code pattern', () => {
    // 预置科目日后会和用户自建科目走同一套校验，格式不一致会在设置页暴露。
    for (const account of SEED_ACCOUNTS) {
      expect(account.code, account.code).toMatch(/^[0-9A-Za-z-]{1,20}$/);
    }
  });

  it('orders accounts by type group so the settings page reads sensibly', () => {
    const sortOrders = SEED_ACCOUNTS.map((a) => a.sortOrder);
    expect(new Set(sortOrders).size, 'sortOrder must be unique').toBe(sortOrders.length);
    expect([...sortOrders].sort((a, b) => a - b)).toEqual(sortOrders);
  });
});

describe('SEED_CATEGORIES', () => {
  it('references only codes that exist in SEED_ACCOUNTS', () => {
    const codes = new Set(SEED_ACCOUNTS.map((a) => a.code));
    for (const category of SEED_CATEGORIES) {
      expect(codes.has(category.accountCode), category.accountCode).toBe(true);
    }
  });

  it('maps income categories to revenue accounts and expense categories to expense accounts', () => {
    const byCode = new Map(SEED_ACCOUNTS.map((a) => [a.code, a]));
    for (const category of SEED_CATEGORIES) {
      const account = byCode.get(category.accountCode);
      const expected = category.kind === 'income' ? 'revenue' : 'expense';
      expect(account?.type, category.accountCode).toBe(expected);
    }
  });

  it('has at least one income and several expense categories', () => {
    expect(SEED_CATEGORIES.filter((c) => c.kind === 'income').length).toBeGreaterThanOrEqual(2);
    expect(SEED_CATEGORIES.filter((c) => c.kind === 'expense').length).toBeGreaterThanOrEqual(7);
  });

  it('provides both language names for every category', () => {
    for (const category of SEED_CATEGORIES) {
      expect(category.nameEn.length, category.nameEn).toBeGreaterThan(0);
      expect(category.nameZh.length, category.nameEn).toBeGreaterThan(0);
    }
  });
});
