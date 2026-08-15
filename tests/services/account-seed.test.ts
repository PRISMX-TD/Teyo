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

describe('seeded accounts carry a cash-flow category', () => {
  it('classifies non-money accounts and leaves money accounts null', () => {
    for (const account of SEED_ACCOUNTS) {
      if (account.isMoneyAccount) {
        expect(account.cashFlowCategory, `${account.code} is a money account`).toBeUndefined();
      } else if (account.type === 'revenue' || account.type === 'expense') {
        expect(account.cashFlowCategory, `${account.code} should be operating`).toBe('operating');
      }
    }
  });

  it('classifies fixed-asset accounts as investing', () => {
    const equipment = SEED_ACCOUNTS.find((a) => a.code === 'equipment');
    expect(equipment?.cashFlowCategory).toBe('investing');
  });

  it('classifies capital and loans as financing', () => {
    expect(SEED_ACCOUNTS.find((a) => a.code === 'capital')?.cashFlowCategory).toBe('financing');
    expect(SEED_ACCOUNTS.find((a) => a.code === 'loans')?.cashFlowCategory).toBe('financing');
  });

  it('classifies operating liability accounts as operating', () => {
    for (const code of ['accounts-payable', 'tax-payable', 'deferred-revenue']) {
      expect(SEED_ACCOUNTS.find((a) => a.code === code)?.cashFlowCategory, code).toBe('operating');
    }
  });

  it('classifies AR, inventory and prepaid expenses as operating working-capital adjustments', () => {
    // server/repositories/reports.ts already folds -netFlow('accounts-receivable'),
    // -netFlow('inventory') and -netFlow('prepaid-expenses') into operatingTotal,
    // the same indirect-method treatment as accounts-payable (sign-flipped
    // because they're asset-side). This is not a new judgment call.
    for (const code of ['accounts-receivable', 'inventory', 'prepaid-expenses']) {
      expect(SEED_ACCOUNTS.find((a) => a.code === code)?.cashFlowCategory, code).toBe('operating');
    }
  });
});

describe('novice-surface seed accounts', () => {
  it('seeds a suspense account with no cash-flow category', () => {
    const suspense = SEED_ACCOUNTS.find((a) => a.code === 'suspense');
    expect(suspense).toBeDefined();
    expect(suspense!.type).toBe('asset');
    expect(suspense!.isMoneyAccount).toBe(false);
    expect(suspense!.cashFlowCategory).toBeUndefined();
  });

  it('seeds a purchases account so a trading business can compute margin', () => {
    const purchases = SEED_ACCOUNTS.find((a) => a.code === 'purchases');
    expect(purchases).toBeDefined();
    expect(purchases!.type).toBe('expense');
    expect(purchases!.cashFlowCategory).toBe('operating');
  });
});
