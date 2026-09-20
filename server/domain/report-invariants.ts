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

export type TrialBalanceLike = {
  code: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  debitMinor: bigint;
  creditMinor: bigint;
};

export type BalanceSheetRowLike = {
  code: string;
  type: 'asset' | 'liability' | 'equity';
  totalMinor: bigint;
};

export type CrossFootCheck = BalanceCheck & {
  /** 逐科目差额的绝对值之和不为 0 时，列出对不上的科目代码。 */
  mismatchedCodes: string[];
};

/**
 * I11：同一 asOf 下，试算平衡表的资产/负债/权益部分必须与资产负债表**逐科目**相等。
 *
 * 为什么值得加这一条，而 I5/I6/I8 三条不够：
 *
 * I6 只说试算平衡表自己借贷相等，I5 只说资产负债表自己配平。两张表是**两条
 * 独立的 SQL**（getTrialBalance 与 getBalanceSheet），各自都能自洽地算错：
 * 只要其中一条的 `voided_at is null`、`occurred_on <= asOf`、或者那句
 * 「归档但仍有余额的科目要保留」（I10）与另一条不一致，两张表就会给出不同
 * 的数字，而 I5 与 I6 各自仍然读「平」。用户看到的是同一天的两张报表对不上，
 * 没有任何一条不变量指出是哪里不一致。
 *
 * 这条检查把两条查询钉在一起：同一个 asOf 下，它们对每一个资产/负债/权益
 * 科目必须给出同一个余额。符号约定与资产负债表一致——资产取借减贷，
 * 负债/权益取贷减借。
 *
 * 为什么**不**把损益类科目也纳进来：试算平衡表是 as-of 累计（自开业以来），
 * 而损益表是期间 [from, to]。只有当期间覆盖了全部历史时两者才相等，而报表
 * 页传的是本年度（yearStart..today）。把它们放在一起比，第二年开始就会
 * 天天报「不平」——一条永远为真的警报等于没有警报。
 *
 * 与本文件其余部分一样：返回差额而不是抛错。differenceMinor 取**逐科目差额
 * 的绝对值之和**，不是简单求和——后者会让两个方向相反的错误互相抵消，
 * 报出一个漂亮的 0。
 */
export function checkTrialBalanceAgainstBalanceSheet(input: {
  trialBalance: readonly TrialBalanceLike[];
  balanceSheetRows: readonly BalanceSheetRowLike[];
}): CrossFootCheck {
  const fromTrialBalance = new Map<string, bigint>();
  for (const row of input.trialBalance) {
    if (row.type === 'revenue' || row.type === 'expense') continue;
    const signed =
      row.type === 'asset'
        ? row.debitMinor - row.creditMinor
        : row.creditMinor - row.debitMinor;
    fromTrialBalance.set(row.code, (fromTrialBalance.get(row.code) ?? 0n) + signed);
  }

  const fromBalanceSheet = new Map<string, bigint>();
  for (const row of input.balanceSheetRows) {
    fromBalanceSheet.set(row.code, (fromBalanceSheet.get(row.code) ?? 0n) + row.totalMinor);
  }

  const codes = new Set([...fromTrialBalance.keys(), ...fromBalanceSheet.keys()]);
  let difference = 0n;
  const mismatchedCodes: string[] = [];

  for (const code of [...codes].sort()) {
    const delta = (fromBalanceSheet.get(code) ?? 0n) - (fromTrialBalance.get(code) ?? 0n);
    if (delta !== 0n) {
      difference += delta < 0n ? -delta : delta;
      mismatchedCodes.push(code);
    }
  }

  return { ...check(difference), mismatchedCodes };
}
