import { describe, it, expect } from 'vitest';
import { templateFor, type PostingEvent } from '../../server/domain/posting-templates';

describe('posting-templates', () => {
  it('income: debits money account, credits revenue account', () => {
    const event: PostingEvent = {
      type: 'income',
      moneyAccountId: 'checking',
      revenueAccountId: 'sales-revenue',
      amountMinor: 10000n,
    };

    const lines = templateFor(event);

    expect(lines).toHaveLength(2);
    const [debitLine, creditLine] = lines.sort((a, b) => (a.direction === 'debit' ? -1 : 1));

    expect(debitLine.direction).toBe('debit');
    expect(debitLine.accountId).toBe('checking');
    expect(debitLine.amountMinor).toBe(10000n);

    expect(creditLine.direction).toBe('credit');
    expect(creditLine.accountId).toBe('sales-revenue');
    expect(creditLine.amountMinor).toBe(10000n);
  });

  it('expense: debits expense account, credits money account', () => {
    const event: PostingEvent = {
      type: 'expense',
      moneyAccountId: 'checking',
      expenseAccountId: 'office-supplies',
      amountMinor: 5000n,
    };

    const lines = templateFor(event);

    expect(lines).toHaveLength(2);
    const [debitLine, creditLine] = lines.sort((a, b) => (a.direction === 'debit' ? -1 : 1));

    expect(debitLine.direction).toBe('debit');
    expect(debitLine.accountId).toBe('office-supplies');
    expect(debitLine.amountMinor).toBe(5000n);

    expect(creditLine.direction).toBe('credit');
    expect(creditLine.accountId).toBe('checking');
    expect(creditLine.amountMinor).toBe(5000n);
  });

  it('transfer: debits destination account, credits source account', () => {
    const event: PostingEvent = {
      type: 'transfer',
      fromAccountId: 'savings',
      toAccountId: 'checking',
      amountMinor: 25000n,
    };

    const lines = templateFor(event);

    expect(lines).toHaveLength(2);
    const [debitLine, creditLine] = lines.sort((a, b) => (a.direction === 'debit' ? -1 : 1));

    expect(debitLine.direction).toBe('debit');
    expect(debitLine.accountId).toBe('checking');
    expect(debitLine.amountMinor).toBe(25000n);

    expect(creditLine.direction).toBe('credit');
    expect(creditLine.accountId).toBe('savings');
    expect(creditLine.amountMinor).toBe(25000n);
  });

  it('journal: debits and credits accounts specified by caller', () => {
    const event: PostingEvent = {
      type: 'journal',
      debitAccountId: 'inventory',
      creditAccountId: 'accounts-payable',
      amountMinor: 15000n,
    };

    const lines = templateFor(event);

    expect(lines).toHaveLength(2);
    const [debitLine, creditLine] = lines.sort((a, b) => (a.direction === 'debit' ? -1 : 1));

    expect(debitLine.direction).toBe('debit');
    expect(debitLine.accountId).toBe('inventory');
    expect(debitLine.amountMinor).toBe(15000n);

    expect(creditLine.direction).toBe('credit');
    expect(creditLine.accountId).toBe('accounts-payable');
    expect(creditLine.amountMinor).toBe(15000n);
  });

  // ledger.ts's buildJournalLines used to refuse a transfer or journal whose
  // two sides named the same account; that function is gone, and posting
  // direction now lives only here. buildLines cannot carry that rule -- it takes an
  // arbitrary n-line spec, where two lines on one account on the same side are
  // legitimate. templateFor is where it belongs: all four shapes are exactly
  // one debit against one credit, and a debit and a credit on one account
  // balance perfectly, pass assertBalanced, pass the ownership check and post
  // a meaningless wash entry.
  it('refuses an event whose debit and credit name the same account', () => {
    const sameAccountEvents: PostingEvent[] = [
      { type: 'income', moneyAccountId: 'cash', revenueAccountId: 'cash', amountMinor: 100n },
      { type: 'expense', moneyAccountId: 'cash', expenseAccountId: 'cash', amountMinor: 100n },
      { type: 'transfer', fromAccountId: 'cash', toAccountId: 'cash', amountMinor: 100n },
      { type: 'journal', debitAccountId: 'cash', creditAccountId: 'cash', amountMinor: 100n },
    ];

    for (const event of sameAccountEvents) {
      expect(() => templateFor(event)).toThrow(/different accounts/i);
    }
  });

  it('each event returns exactly one debit line and one credit line', () => {
    const events: PostingEvent[] = [
      {
        type: 'income',
        moneyAccountId: 'cash',
        revenueAccountId: 'revenue',
        amountMinor: 100n,
      },
      {
        type: 'expense',
        moneyAccountId: 'cash',
        expenseAccountId: 'expense',
        amountMinor: 50n,
      },
      {
        type: 'transfer',
        fromAccountId: 'savings',
        toAccountId: 'checking',
        amountMinor: 200n,
      },
      {
        type: 'journal',
        debitAccountId: 'debit-acct',
        creditAccountId: 'credit-acct',
        amountMinor: 75n,
      },
    ];

    for (const event of events) {
      const lines = templateFor(event);
      expect(lines).toHaveLength(2);

      const debits = lines.filter((line) => line.direction === 'debit');
      const credits = lines.filter((line) => line.direction === 'credit');

      expect(debits).toHaveLength(1);
      expect(credits).toHaveLength(1);
      expect(debits[0].amountMinor).toBe(credits[0].amountMinor);
    }
  });
});
