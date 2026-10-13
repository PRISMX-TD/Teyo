import { describe, expect, it } from 'vitest';
import { defaultMoneyAccountId, type MoneyAccountOption } from '@/lib/payment-methods';

const CASH: MoneyAccountOption = { id: 'a-cash', code: 'cash', name: '现金' };
const BANK: MoneyAccountOption = { id: 'a-bank', code: 'bank', name: '银行' };
const MAYBANK: MoneyAccountOption = { id: 'a-maybank', code: 'maybank', name: 'Maybank' };

describe('defaultMoneyAccountId', () => {
  it('picks the built-in cash account for cash and the built-in bank for everything else', () => {
    const accounts = [CASH, BANK, MAYBANK];
    expect(defaultMoneyAccountId(accounts, 'cash')).toBe('a-cash');
    expect(defaultMoneyAccountId(accounts, 'bank_transfer')).toBe('a-bank');
    expect(defaultMoneyAccountId(accounts, 'cheque')).toBe('a-bank');
    expect(defaultMoneyAccountId(accounts, 'online')).toBe('a-bank');
    expect(defaultMoneyAccountId(accounts, 'other')).toBe('a-bank');
  });

  it('falls back to the first non-cash account when the built-in bank is archived', () => {
    // 停用的账户不在清单里。原来这种情况下钱照样记进那个停用的「银行」。
    expect(defaultMoneyAccountId([CASH, MAYBANK], 'bank_transfer')).toBe('a-maybank');
  });

  it('falls back to the first account when there is nothing better', () => {
    expect(defaultMoneyAccountId([MAYBANK], 'cash')).toBe('a-maybank');
    expect(defaultMoneyAccountId([CASH], 'bank_transfer')).toBe('a-cash');
    expect(defaultMoneyAccountId([], 'cash')).toBe('');
  });
});
