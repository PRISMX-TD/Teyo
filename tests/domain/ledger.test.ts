import { describe, expect, it } from 'vitest';
import { RATE_SCALE } from '@/server/domain/exchange-rate';
import {
  LedgerError,
  assertBalanced,
  buildLines,
  type BuildLinesContext,
  type DraftJournalLine,
} from '@/server/domain/ledger';
import { templateFor, type PostingEvent } from '@/server/domain/posting-templates';

const BANK = 'account-bank';
const CASH = 'account-cash';
const SALES = 'account-sales';
const RENT = 'account-rent';

/**
 * 这些用例原来喂的是 ledger.ts 里的 buildJournalLines——一个把四种操作各自
 * 映射成一对借贷分录的函数。它在生产代码里早已没有调用者（记账方向归
 * templateFor 管），却仍然是第二份「哪种操作借哪个科目」的定义，于是被删掉了。
 *
 * 用例跟着搬到真正在跑的那条链上：templateFor 决定方向，buildLines 换算
 * 本位币金额。这是 post-journal.ts 的 buildValidatedLines 逐字做的两步，
 * 所以这里量的是生产路径本身，而不是一个平行实现。
 */
const domestic: BuildLinesContext = {
  currency: 'MYR',
  baseCurrency: 'MYR',
  scaledRate: RATE_SCALE,
};

function post(event: PostingEvent, ctx: BuildLinesContext = domestic): DraftJournalLine[] {
  return buildLines(templateFor(event), ctx);
}

describe('templateFor + buildLines - income', () => {
  it('debits the money account and credits the revenue account', () => {
    const lines = post({
      type: 'income',
      moneyAccountId: BANK,
      revenueAccountId: SALES,
      amountMinor: 50000n,
    });

    expect(lines).toEqual([
      { accountId: BANK, direction: 'debit', amountMinor: 50000n, baseAmountMinor: 50000n },
      { accountId: SALES, direction: 'credit', amountMinor: 50000n, baseAmountMinor: 50000n },
    ]);
  });
});

describe('templateFor + buildLines - expense', () => {
  it('debits the expense account and credits the money account', () => {
    const lines = post({
      type: 'expense',
      moneyAccountId: CASH,
      expenseAccountId: RENT,
      amountMinor: 120000n,
    });

    expect(lines).toEqual([
      { accountId: RENT, direction: 'debit', amountMinor: 120000n, baseAmountMinor: 120000n },
      { accountId: CASH, direction: 'credit', amountMinor: 120000n, baseAmountMinor: 120000n },
    ]);
  });
});

describe('templateFor + buildLines - transfer', () => {
  it('debits the destination account and credits the source account', () => {
    const lines = post({
      type: 'transfer',
      toAccountId: BANK,
      fromAccountId: CASH,
      amountMinor: 80000n,
    });

    expect(lines).toEqual([
      { accountId: BANK, direction: 'debit', amountMinor: 80000n, baseAmountMinor: 80000n },
      { accountId: CASH, direction: 'credit', amountMinor: 80000n, baseAmountMinor: 80000n },
    ]);
  });

  it('rejects a transfer between the same account', () => {
    expect(() =>
      post({ type: 'transfer', toAccountId: BANK, fromAccountId: BANK, amountMinor: 50000n }),
    ).toThrow(LedgerError);
  });
});

describe('templateFor + buildLines - foreign currency', () => {
  it('records the original amount on both lines and the converted base amount', () => {
    // 100.00 SGD at 3.5 MYR/SGD = 350.00 MYR
    const lines = post(
      { type: 'income', moneyAccountId: BANK, revenueAccountId: SALES, amountMinor: 10000n },
      { currency: 'SGD', baseCurrency: 'MYR', scaledRate: 3_50000000n },
    );

    expect(lines[0]).toEqual({
      accountId: BANK,
      direction: 'debit',
      amountMinor: 10000n,
      baseAmountMinor: 35000n,
    });
    expect(lines[1]).toEqual({
      accountId: SALES,
      direction: 'credit',
      amountMinor: 10000n,
      baseAmountMinor: 35000n,
    });
  });

  it('keeps both sides balanced in base currency after rounding', () => {
    const lines = post(
      { type: 'expense', moneyAccountId: CASH, expenseAccountId: RENT, amountMinor: 3333n },
      { currency: 'USD', baseCurrency: 'MYR', scaledRate: 4_71834900n },
    );

    expect(() => assertBalanced(lines)).not.toThrow();
  });
});

describe('templateFor + buildLines - validation', () => {
  it('rejects a zero or negative amount', () => {
    expect(() =>
      post({ type: 'income', moneyAccountId: BANK, revenueAccountId: SALES, amountMinor: 0n }),
    ).toThrow(LedgerError);
    expect(() =>
      post({ type: 'income', moneyAccountId: BANK, revenueAccountId: SALES, amountMinor: -1n }),
    ).toThrow(LedgerError);
  });

  it('rejects a non-positive exchange rate', () => {
    expect(() =>
      post(
        { type: 'income', moneyAccountId: BANK, revenueAccountId: SALES, amountMinor: 50000n },
        { currency: 'MYR', baseCurrency: 'MYR', scaledRate: 0n },
      ),
    ).toThrow(LedgerError);
  });

  it('always produces balanced lines for every kind', () => {
    const events: PostingEvent[] = [
      { type: 'income', moneyAccountId: BANK, revenueAccountId: SALES, amountMinor: 50000n },
      { type: 'expense', moneyAccountId: BANK, expenseAccountId: RENT, amountMinor: 50000n },
      { type: 'transfer', toAccountId: BANK, fromAccountId: CASH, amountMinor: 50000n },
      { type: 'journal', debitAccountId: BANK, creditAccountId: SALES, amountMinor: 50000n },
    ];

    for (const event of events) {
      expect(() => assertBalanced(post(event))).not.toThrow();
    }
  });
});

describe('assertBalanced', () => {
  it('accepts lines whose debits equal credits', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 100n, baseAmountMinor: 100n },
      { accountId: SALES, direction: 'credit', amountMinor: 60n, baseAmountMinor: 60n },
      { accountId: RENT, direction: 'credit', amountMinor: 40n, baseAmountMinor: 40n },
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('rejects unbalanced original amounts', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 100n, baseAmountMinor: 100n },
      { accountId: SALES, direction: 'credit', amountMinor: 99n, baseAmountMinor: 100n },
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerError);
  });

  it('rejects unbalanced base amounts even when original amounts balance', () => {
    const lines: DraftJournalLine[] = [
      { accountId: BANK, direction: 'debit', amountMinor: 100n, baseAmountMinor: 350n },
      { accountId: SALES, direction: 'credit', amountMinor: 100n, baseAmountMinor: 349n },
    ];
    expect(() => assertBalanced(lines)).toThrow(LedgerError);
  });

  it('rejects fewer than two lines', () => {
    expect(() => assertBalanced([])).toThrow(LedgerError);
    expect(() =>
      assertBalanced([
        { accountId: BANK, direction: 'debit', amountMinor: 0n, baseAmountMinor: 0n },
      ]),
    ).toThrow(LedgerError);
  });
});
