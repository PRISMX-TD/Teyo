import { describe, expect, it } from 'vitest';
import {
  accountSchema,
  categorySchema,
  createOrgSchema,
  createTransactionSchema,
  exportSchema,
  inviteMemberSchema,
  periodLockSchema,
  transactionFilterSchema,
  voidTransactionSchema,
} from '@/lib/schemas';

describe('createOrgSchema', () => {
  it('accepts a valid payload', () => {
    const result = createOrgSchema.safeParse({
      name: 'Acme Trading',
      baseCurrency: 'MYR',
      timezone: 'Asia/Kuala_Lumpur',
      industry: 'retail',
    });
    expect(result.success).toBe(true);
  });

  it('uppercases the currency code', () => {
    const result = createOrgSchema.parse({
      name: 'Acme',
      baseCurrency: 'myr',
      timezone: 'Asia/Kuala_Lumpur',
    });
    expect(result.baseCurrency).toBe('MYR');
  });

  it('rejects a blank name', () => {
    expect(
      createOrgSchema.safeParse({ name: '   ', baseCurrency: 'MYR', timezone: 'UTC' }).success,
    ).toBe(false);
  });

  it('rejects a currency code that is not three letters', () => {
    for (const baseCurrency of ['MY', 'MYRR', 'M1R', '']) {
      expect(
        createOrgSchema.safeParse({ name: 'Acme', baseCurrency, timezone: 'UTC' }).success,
        baseCurrency,
      ).toBe(false);
    }
  });
});

describe('inviteMemberSchema', () => {
  it('normalises the email to lowercase', () => {
    expect(inviteMemberSchema.parse({ email: 'BOSS@Acme.COM', role: 'bookkeeper' }).email).toBe(
      'boss@acme.com',
    );
  });

  it('refuses to invite someone as owner', () => {
    expect(inviteMemberSchema.safeParse({ email: 'a@b.com', role: 'owner' }).success).toBe(false);
  });

  it('rejects a malformed email', () => {
    expect(inviteMemberSchema.safeParse({ email: 'not-an-email', role: 'viewer' }).success).toBe(
      false,
    );
  });
});

describe('createTransactionSchema', () => {
  const valid = {
    kind: 'expense',
    occurredOn: '2026-08-01',
    amount: '1200.50',
    currency: 'MYR',
    moneyAccountId: '00000000-0000-4000-8000-000000000001',
    categoryId: '00000000-0000-4000-8000-000000000002',
    description: 'Shop rent',
    clientUuid: '00000000-0000-4000-8000-000000000003',
  };

  it('accepts a valid expense', () => {
    expect(createTransactionSchema.safeParse(valid).success).toBe(true);
  });

  it('requires a category for income and expense', () => {
    expect(createTransactionSchema.safeParse({ ...valid, categoryId: undefined }).success).toBe(
      false,
    );
  });

  it('requires a counter account for a transfer and forbids a category', () => {
    expect(
      createTransactionSchema.safeParse({
        ...valid,
        kind: 'transfer',
        categoryId: undefined,
        counterAccountId: '00000000-0000-4000-8000-000000000004',
      }).success,
    ).toBe(true);

    expect(
      createTransactionSchema.safeParse({ ...valid, kind: 'transfer', categoryId: undefined })
        .success,
    ).toBe(false);
  });

  it('rejects a transfer between the same account', () => {
    expect(
      createTransactionSchema.safeParse({
        ...valid,
        kind: 'transfer',
        categoryId: undefined,
        counterAccountId: valid.moneyAccountId,
      }).success,
    ).toBe(false);
  });

  it('forbids a counter account on income and expense', () => {
    expect(
      createTransactionSchema.safeParse({
        ...valid,
        counterAccountId: '00000000-0000-4000-8000-000000000004',
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed date and a non-positive amount', () => {
    expect(createTransactionSchema.safeParse({ ...valid, occurredOn: '01/08/2026' }).success).toBe(
      false,
    );
    expect(createTransactionSchema.safeParse({ ...valid, amount: '0' }).success).toBe(false);
    expect(createTransactionSchema.safeParse({ ...valid, amount: '-5' }).success).toBe(false);
  });

  it('rejects amounts that are not numbers', () => {
    for (const amount of ['abc', '1.2.3', '', '  ']) {
      expect(createTransactionSchema.safeParse({ ...valid, amount }).success, amount).toBe(false);
    }
  });

  it('defaults the description to an empty string', () => {
    const { description, ...withoutDescription } = valid;
    void description;
    const result = createTransactionSchema.parse(withoutDescription);
    expect(result.description).toBe('');
  });

  it('reports the offending field so the form can highlight it', () => {
    const result = createTransactionSchema.safeParse({ ...valid, categoryId: undefined });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('categoryId'))).toBe(true);
    }
  });
});

describe('voidTransactionSchema', () => {
  it('requires a non-empty reason', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(voidTransactionSchema.safeParse({ id, reason: 'Duplicate entry' }).success).toBe(true);
    expect(voidTransactionSchema.safeParse({ id, reason: '   ' }).success).toBe(false);
  });
});

describe('periodLockSchema', () => {
  it('accepts a date or null to unlock', () => {
    expect(periodLockSchema.safeParse({ lockedUntil: '2026-03-31' }).success).toBe(true);
    expect(periodLockSchema.safeParse({ lockedUntil: null }).success).toBe(true);
    expect(periodLockSchema.safeParse({ lockedUntil: '31/03/2026' }).success).toBe(false);
  });
});

describe('accountSchema and categorySchema', () => {
  it('requires a name in at least one language', () => {
    const base = { type: 'asset', code: '1000', isMoneyAccount: true };
    expect(accountSchema.safeParse({ ...base, nameEn: 'Cash' }).success).toBe(true);
    expect(accountSchema.safeParse({ ...base, nameZh: '现金' }).success).toBe(true);
    expect(accountSchema.safeParse(base).success).toBe(false);
  });

  it('rejects an account code with unsupported characters', () => {
    expect(
      accountSchema.safeParse({ nameEn: 'Cash', type: 'asset', code: '10 00' }).success,
    ).toBe(false);
  });

  it('accepts only income or expense categories', () => {
    const accountId = '00000000-0000-4000-8000-000000000001';
    expect(categorySchema.safeParse({ nameEn: 'Sales', kind: 'income', accountId }).success).toBe(
      true,
    );
    expect(categorySchema.safeParse({ nameEn: 'Sales', kind: 'asset', accountId }).success).toBe(
      false,
    );
  });
});

describe('transactionFilterSchema', () => {
  it('defaults page to 1 and coerces a query string value', () => {
    expect(transactionFilterSchema.parse({}).page).toBe(1);
    expect(transactionFilterSchema.parse({ page: '3' }).page).toBe(3);
  });

  it('defaults includeVoided to false', () => {
    expect(transactionFilterSchema.parse({}).includeVoided).toBe(false);
  });

  it('rejects a page below 1', () => {
    expect(transactionFilterSchema.safeParse({ page: '0' }).success).toBe(false);
  });
});

describe('exportSchema', () => {
  const valid = {
    kind: 'transaction-detail',
    format: 'csv',
    from: '2026-01-01',
    to: '2026-01-31',
    locale: 'en',
  };

  it('accepts a valid range', () => {
    expect(exportSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a range that ends before it starts', () => {
    const result = exportSchema.safeParse({ ...valid, from: '2026-02-01', to: '2026-01-31' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('from'))).toBe(true);
    }
  });

  it('accepts a single-day range', () => {
    expect(exportSchema.safeParse({ ...valid, from: '2026-01-31', to: '2026-01-31' }).success).toBe(
      true,
    );
  });
});
