/**
 * 报表级不变量。
 *
 * 返回差额而不是抛错：报表页必须把"账不平"这件事显示给用户，
 * 抛错会让整页 500，而这恰恰是最需要被看见的信息。
 * 测试侧断言 balanced === true。
 */
export type BalanceCheck = {
  balanced: boolean;
  /** 左侧 − 右侧。正数表示左侧偏大。 */
  differenceMinor: bigint;
};

function check(differenceMinor: bigint): BalanceCheck {
  return { balanced: differenceMinor === 0n, differenceMinor };
}

/** I5：资产 = 负债 + 权益 + 本年利润 */
export function checkBalanceSheet(input: {
  assetTotal: bigint;
  liabilityTotal: bigint;
  equityTotal: bigint;
  currentYearEarnings: bigint;
}): BalanceCheck {
  const { assetTotal, liabilityTotal, equityTotal, currentYearEarnings } = input;
  return check(assetTotal - (liabilityTotal + equityTotal + currentYearEarnings));
}

/** I6：试算平衡表借方合计 = 贷方合计 */
export function checkTrialBalance(
  rows: { debitMinor: bigint; creditMinor: bigint }[],
): BalanceCheck {
  let debit = 0n;
  let credit = 0n;
  for (const row of rows) {
    debit += row.debitMinor;
    credit += row.creditMinor;
  }
  return check(debit - credit);
}

/** I8：期初现金 + 净变动 = 期末现金 */
export function checkCashFlow(input: {
  openingCash: bigint;
  netChange: bigint;
  closingCash: bigint;
}): BalanceCheck {
  const { openingCash, netChange, closingCash } = input;
  return check(openingCash + netChange - closingCash);
}
