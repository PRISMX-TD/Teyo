/**
 * 收付方式，以及每种方式缺省落到哪个资金科目。
 *
 * 0037 之前 payments 表没有账户列，资金科目只能从方式推：现金进 'cash'，
 * 其余（转账/支票/在线/其他）进 'bank'——公司建了几个银行户口，收付款也
 * 只会进系统自带的那一个，真正收到钱的户口余额不动，按户口做的银行对账
 * 对不上。现在账户由用户在表单上选，这张表退成两件事：
 *   - 表单上「收款账户」的缺省值（defaultMoneyAccountId）；
 *   - createPayment 没收到账户时的兜底。
 *
 * 放在 lib/ 而不是 server/repositories/payments.ts：表单是客户端组件，
 * 要的只是这张表，不该为它把一个查库的模块拖进浏览器。
 */
export const MONEY_ACCOUNT_CODE_BY_METHOD = {
  cash: 'cash',
  bank_transfer: 'bank',
  cheque: 'bank',
  online: 'bank',
  other: 'bank',
} as const;

export type PaymentMethod = keyof typeof MONEY_ACCOUNT_CODE_BY_METHOD;

/** 表单下拉里的一个资金账户。name 已按界面语言取好。 */
export type MoneyAccountOption = { id: string; code: string; name: string };

/**
 * 这种方式缺省该选哪个账户。传进来的只有启用中的账户。
 *
 * 系统自带的那一个（'cash' / 'bank'）在清单里就选它，行为与 0037 之前一致。
 * 不在——多半是用户把自带的「银行」停用了、改用自己建的户口——非现金方式
 * 选第一个不是现金的账户，现金方式选第一个。原来这种情况下钱会照样记进
 * 那个已停用的科目，用户在任何下拉框里都看不到它。
 */
export function defaultMoneyAccountId(
  accounts: readonly MoneyAccountOption[],
  method: PaymentMethod,
): string {
  const code = MONEY_ACCOUNT_CODE_BY_METHOD[method];
  const own = accounts.find((account) => account.code === code);
  if (own) return own.id;
  if (code !== 'cash') {
    const nonCash = accounts.find((account) => account.code !== 'cash');
    if (nonCash) return nonCash.id;
  }
  return accounts[0]?.id ?? '';
}
