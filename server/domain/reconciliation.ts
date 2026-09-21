/**
 * 银行对账的那一条恒等式。
 *
 * 抽成纯函数不是为了复用——只有一个调用方（components/reconciliation/
 * reconciliation-view.tsx）。是为了让它**可被测试**：这条式子原来写在组件
 * 里，写错了没有任何测试会红，而它错的方式是"界面看起来一切正常，只是
 * 那个按钮永远点不下去"。
 *
 * 原来的写法是：
 *
 *     difference = 对账单余额 - (账面余额 + 调整)
 *
 * 账面余额是**全部**交易的净额，与用户勾了哪几笔毫无关系。于是勾选框对差额
 * 没有任何影响，而「完成对账」这个按钮是被 `difference !== 0n` 锁着的——
 * 只要手上还有一张没兑现的支票，差额就永远归不了零，这一页就永远走不完。
 * 而"手上还有没兑现的支票"恰恰是人们要对账的原因。
 *
 * 正确的式子就是银行对账本来的样子：
 *
 *     以前各期已对完的余额
 *   + 本期在对账单上出现的交易（勾上的那些）
 *   + 调整项（银行手续费一类账上还没记的）
 *   = 对账单余额
 *
 * 「以前各期已对完的余额」不必再查一次库：账面余额减去所有未对账交易的净
 * 影响，剩下的就是它。
 */

export type ReconciliationInput = {
  /** 该资金账户所有未作废分录的净额，本位币最小单位，借正贷负。 */
  bookBalanceMinor: bigint;
  /** 每一笔未对账交易对该账户的净影响，本位币最小单位，进正出负。 */
  unreconciledEffects: readonly bigint[];
  /** 其中被勾上（即出现在这张对账单上）的那些。 */
  clearedEffects: readonly bigint[];
  /** 勾上的那些行上填的调整金额合计，可正可负。 */
  adjustmentMinor: bigint;
  /** 用户从对账单上抄下来的余额。 */
  statementBalanceMinor: bigint;
};

export type ReconciliationSummary = {
  /** 以前各期已对完的余额。 */
  priorBalanceMinor: bigint;
  /** 本期已清（勾选合计 + 调整）。 */
  clearedMinor: bigint;
  /** 按账推算，这张对账单上应该是多少。 */
  expectedBalanceMinor: bigint;
  /** 对账单余额减去推算值。归零才算对平。 */
  differenceMinor: bigint;
};

function total(values: readonly bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}

export function reconciliationSummary(input: ReconciliationInput): ReconciliationSummary {
  const priorBalanceMinor = input.bookBalanceMinor - total(input.unreconciledEffects);
  const clearedMinor = total(input.clearedEffects) + input.adjustmentMinor;
  const expectedBalanceMinor = priorBalanceMinor + clearedMinor;

  return {
    priorBalanceMinor,
    clearedMinor,
    expectedBalanceMinor,
    differenceMinor: input.statementBalanceMinor - expectedBalanceMinor,
  };
}
