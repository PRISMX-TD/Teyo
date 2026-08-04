import type { Tx } from '@/server/db/transaction';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type TrialBalanceRow = {
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  type: AccountType;
  debitMinor: bigint;
  creditMinor: bigint;
};

export type ProfitLossRow = {
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  type: 'revenue' | 'expense';
  totalMinor: bigint;
};

export type BalanceSheetRow = {
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  type: AssetOrLiabilityOrEquity;
  totalMinor: bigint;
};

type AssetOrLiabilityOrEquity = 'asset' | 'liability' | 'equity';

/**
 * 试算平衡表：每个科目的借/贷方发生额汇总。
 *
 * 只算未作废交易。direction 本身就在分录行上，不必 join transactions 表拿 kind，
 * 也天然把转账两行按各自的 direction 算进对应科目。
 */
export async function getTrialBalance(
  tx: Tx,
  organizationId: string,
  asOf: string,
): Promise<TrialBalanceRow[]> {
  const rows = await tx`
    select
      a.code,
      a.name_en,
      a.name_zh,
      a.type,
      coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor else 0 end), 0) as debit,
      coalesce(sum(case when l.direction = 'credit' then l.base_amount_minor else 0 end), 0) as credit
    from accounts a
    left join journal_lines l on l.account_id = a.id and l.organization_id = ${organizationId}
    left join transactions t on t.id = l.transaction_id and t.organization_id = ${organizationId}
      and t.voided_at is null
      and t.occurred_on <= ${asOf}::date
    where a.organization_id = ${organizationId} and a.is_active
    group by a.id, a.code, a.name_en, a.name_zh, a.type, a.sort_order
    order by a.sort_order, a.id
  `;

  return rows.map((r) => ({
    code: r.code as string,
    nameEn: (r.name_en as string | null) ?? null,
    nameZh: (r.name_zh as string | null) ?? null,
    type: r.type as AccountType,
    debitMinor: BigInt(r.debit as string),
    creditMinor: BigInt(r.credit as string),
  }));
}

export type ProfitLossResult = {
  revenueRows: ProfitLossRow[];
  expenseRows: ProfitLossRow[];
  revenueTotal: bigint;
  expenseTotal: bigint;
  netIncome: bigint;
};

/**
 * 损益表：收入 - 费用 = 净利润。
 *
 * 金额取 base_amount_minor（本位币），这样不同币种的交易可以加在一起。
 * 只算未作废交易，期间用半开区间 [start, end)。
 */
export async function getProfitLoss(
  tx: Tx,
  organizationId: string,
  from: string,
  to: string,
): Promise<ProfitLossResult> {
  const rows = await tx`
    select
      a.code,
      a.name_en,
      a.name_zh,
      a.type,
      coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor else 0 end), 0) as debit,
      coalesce(sum(case when l.direction = 'credit' then l.base_amount_minor else 0 end), 0) as credit
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    join accounts a on a.id = l.account_id
    where l.organization_id = ${organizationId}
      and t.voided_at is null
      and t.occurred_on >= ${from}::date
      and t.occurred_on < ${to}::date
      and (a.type = 'revenue' or a.type = 'expense')
    group by a.id, a.code, a.name_en, a.name_zh, a.type, a.sort_order
    order by a.sort_order, a.id
  `;

  // revenue 正常在贷方，expense 正常在借方
  const revenueRows: ProfitLossRow[] = [];
  const expenseRows: ProfitLossRow[] = [];

  for (const r of rows) {
    const debitMinor = BigInt(r.debit as string);
    const creditMinor = BigInt(r.credit as string);
    const type = r.type as 'revenue' | 'expense';

    const totalMinor = type === 'revenue'
      ? creditMinor - debitMinor
      : debitMinor - creditMinor;

    const row: ProfitLossRow = {
      code: r.code as string,
      nameEn: (r.name_en as string | null) ?? null,
      nameZh: (r.name_zh as string | null) ?? null,
      type,
      totalMinor,
    };
    if (type === 'revenue') revenueRows.push(row);
    else expenseRows.push(row);
  }

  const revenueTotal = revenueRows.reduce((sum, r) => sum + r.totalMinor, 0n);
  const expenseTotal = expenseRows.reduce((sum, r) => sum + r.totalMinor, 0n);

  return {
    revenueRows,
    expenseRows,
    revenueTotal,
    expenseTotal,
    netIncome: revenueTotal - expenseTotal,
  };
}

export type BalanceSheetResult = {
  assetRows: BalanceSheetRow[];
  liabilityRows: BalanceSheetRow[];
  equityRows: BalanceSheetRow[];
  assetTotal: bigint;
  liabilityTotal: bigint;
  equityTotal: bigint;
  netIncome: bigint;
};

/**
 * 资产负债表：资产 = 负债 + 权益。
 *
 * 余额定义：
 * - 资产类：借方合计 - 贷方合计（正常余额在借方）
 * - 负债/权益类：贷方合计 - 借方合计（正常余额在贷方）
 *
 * 权益中包含了当期净利润（损益表结果），所以 A = L + E 自然平衡。
 */
export async function getBalanceSheet(
  tx: Tx,
  organizationId: string,
  asOf: string,
  netIncome: bigint,
): Promise<BalanceSheetResult> {
  const rows = await tx`
    select
      a.code,
      a.name_en,
      a.name_zh,
      a.type,
      coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor else 0 end), 0) as debit,
      coalesce(sum(case when l.direction = 'credit' then l.base_amount_minor else 0 end), 0) as credit
    from accounts a
    left join journal_lines l on l.account_id = a.id and l.organization_id = ${organizationId}
    left join transactions t on t.id = l.transaction_id and t.organization_id = ${organizationId}
      and t.voided_at is null
      and t.occurred_on <= ${asOf}::date
    where a.organization_id = ${organizationId}
      and a.is_active
      and a.type in ('asset', 'liability', 'equity')
    group by a.id, a.code, a.name_en, a.name_zh, a.type, a.sort_order
    order by a.sort_order, a.id
  `;

  const assetRows: BalanceSheetRow[] = [];
  const liabilityRows: BalanceSheetRow[] = [];
  const equityRows: BalanceSheetRow[] = [];

  for (const r of rows) {
    const debitMinor = BigInt(r.debit as string);
    const creditMinor = BigInt(r.credit as string);
    const type = r.type as AssetOrLiabilityOrEquity;

    // 资产正常余额在借方，负债/权益在贷方
    let totalMinor: bigint;
    if (type === 'asset') {
      totalMinor = debitMinor - creditMinor;
    } else {
      totalMinor = creditMinor - debitMinor;
    }

    // 留存收益科目：叠加当期净利润
    if (r.code === 'retained-earnings') {
      totalMinor = totalMinor + netIncome;
    }

    const row: BalanceSheetRow = {
      code: r.code as string,
      nameEn: (r.name_en as string | null) ?? null,
      nameZh: (r.name_zh as string | null) ?? null,
      type,
      totalMinor,
    };

    if (type === 'asset') assetRows.push(row);
    else if (type === 'liability') liabilityRows.push(row);
    else equityRows.push(row);
  }

  const assetTotal = assetRows.reduce((sum, r) => sum + r.totalMinor, 0n);
  const liabilityTotal = liabilityRows.reduce((sum, r) => sum + r.totalMinor, 0n);
  const equityTotal = equityRows.reduce((sum, r) => sum + r.totalMinor, 0n);

  return { assetRows, liabilityRows, equityRows, assetTotal, liabilityTotal, equityTotal, netIncome };
}

/* =========================================================================
   现金流量表
   ========================================================================= */

export type CashFlowSection = {
  label: string;
  rows: { label: string; amountMinor: bigint }[];
};

export type CashFlowResult = {
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChange: bigint;
  openingCash: bigint;
  closingCash: bigint;
};

/**
 * 间接法现金流量表。
 *
 * 从净利润出发，加减非现金项目和营运资金变动，得到经营活动现金流。
 * 投资和融资活动直接从科目变动推算。
 *
 * 实现中分类依赖账户的 code 前缀匹配，种子数据 code 设计时已考虑这一点。
 */
export async function getCashFlow(
  tx: Tx,
  organizationId: string,
  from: string,
  to: string,
): Promise<CashFlowResult> {
  // --- 辅助：单科目期间发生额（本位币，借正贷负） ---
  async function netFlow(code: string): Promise<bigint> {
    const r = await tx`
      select
        coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                          else -l.base_amount_minor end), 0) as net
      from journal_lines l
      join transactions t on t.id = l.transaction_id
      join accounts a on a.id = l.account_id
      where l.organization_id = ${organizationId}
        and a.code = ${code}
        and t.voided_at is null
        and t.occurred_on >= ${from}::date
        and t.occurred_on < ${to}::date
    `;
    return BigInt(r[0].net as string);
  }

  // --- 辅助：期初/期末余额 ---
  async function balanceAsOf(code: string, asOf: string): Promise<bigint> {
    const r = await tx`
      select
        coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                          else -l.base_amount_minor end), 0) as net
      from journal_lines l
      join transactions t on t.id = l.transaction_id
      join accounts a on a.id = l.account_id
      where l.organization_id = ${organizationId}
        and a.code = ${code}
        and t.voided_at is null
        and t.occurred_on <= ${asOf}::date
    `;
    return BigInt(r[0].net as string);
  }

  // --- 经营活动 ---
  // 净利润：P&L 的 net（间接法起点）
  const pl = await getProfitLoss(tx, organizationId, from, to);
  const netIncome = pl.netIncome;

  // 加回非现金费用
  const depreciation = await netFlow('depreciation');
  const amortization = await netFlow('amortization');

  // 营运资金变动
  // AR 增加 = 现金减少（借贷记在资产端，ar 的 net = debit-credit，资产增加意味着 net>0，所以 cash 影响是 -netFlow）
  const arChange = -(await netFlow('accounts-receivable'));
  // AP 增加 = 现金增加
  const apChange = await netFlow('accounts-payable');
  // Inventory 增加 = 现金减少（借买存货）
  const invChange = -(await netFlow('inventory'));

  // 递延收入变动
  const deferredRevChange = await netFlow('deferred-revenue');
  // 预付费用变动
  const prepaidChange = -(await netFlow('prepaid-expenses'));

  const operatingTotal = netIncome
    + depreciation
    + amortization
    + arChange
    + apChange
    + invChange
    + deferredRevChange
    + prepaidChange;

  const operating: CashFlowSection = {
    label: 'Operating',
    rows: [
      { label: 'netIncome', amountMinor: netIncome },
      { label: 'depreciation', amountMinor: depreciation },
      { label: 'amortization', amountMinor: amortization },
      { label: 'arChange', amountMinor: arChange },
      { label: 'apChange', amountMinor: apChange },
      { label: 'invChange', amountMinor: invChange },
      { label: 'deferredRevChange', amountMinor: deferredRevChange },
      { label: 'prepaidChange', amountMinor: prepaidChange },
    ],
  };

  // --- 投资活动 ---
  const equipment = -(await netFlow('equipment'));
  const furniture = -(await netFlow('furniture'));
  const vehicles = -(await netFlow('vehicles'));
  const softwareIntangible = -(await netFlow('software-intangible'));

  const investingTotal = equipment + furniture + vehicles + softwareIntangible;

  const investing: CashFlowSection = {
    label: 'Investing',
    rows: [
      { label: 'equipment', amountMinor: equipment },
      { label: 'furniture', amountMinor: furniture },
      { label: 'vehicles', amountMinor: vehicles },
      { label: 'softwareIntangible', amountMinor: softwareIntangible },
    ],
  };

  // --- 融资活动 ---
  const capital = await netFlow('capital');
  const loans = await netFlow('loans');
  const ownersDraw = -(await netFlow('owners-draw'));

  const financingTotal = capital + loans + ownersDraw;

  const financing: CashFlowSection = {
    label: 'Financing',
    rows: [
      { label: 'capital', amountMinor: capital },
      { label: 'loans', amountMinor: loans },
      { label: 'ownersDraw', amountMinor: ownersDraw },
    ],
  };

  const netChange = operatingTotal + investingTotal + financingTotal;

  // 期初/期末现金 = cash + bank 余额
  const openingCash =
    (await balanceAsOf('cash', from)) + (await balanceAsOf('bank', from));
  const closingCash =
    (await balanceAsOf('cash', to)) + (await balanceAsOf('bank', to));

  return {
    operating,
    investing,
    financing,
    netChange,
    openingCash,
    closingCash,
  };
}

/* =========================================================================
   总账（General Ledger）
   ========================================================================= */

export type LedgerLine = {
  date: string;
  description: string;
  kind: string;
  debitMinor: bigint;
  creditMinor: bigint;
  balanceMinor: bigint;
};

export type LedgerResult = {
  accountCode: string;
  accountNameEn: string | null;
  accountNameZh: string | null;
  lines: LedgerLine[];
  openingBalance: bigint;
  closingBalance: bigint;
};

/**
 * 单科目的总账——按日期的分录列表 + 递进余额。
 */
export async function getGeneralLedger(
  tx: Tx,
  organizationId: string,
  accountId: string,
  from: string,
  to: string,
): Promise<LedgerResult> {
  // 科目信息 + 期初余额
  const accountRows = await tx`
    select code, name_en, name_zh, type from accounts
    where id = ${accountId} and organization_id = ${organizationId}
  `;
  const account = accountRows[0];
  if (!account) throw new Error('Account not found');

  const openingRows = await tx`
    select
      coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                        else -l.base_amount_minor end), 0) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    where l.account_id = ${accountId}
      and l.organization_id = ${organizationId}
      and t.voided_at is null
      and t.occurred_on < ${from}::date
  `;
  let openingBalance = BigInt(openingRows[0].net as string);
  // 负债、权益、收入类科目正常余额在贷方
  const acctType = account.type as string;
  if (acctType === 'liability' || acctType === 'equity' || acctType === 'revenue') {
    openingBalance = -openingBalance;
  }

  // 期间分录
  const lineRows = await tx`
    select
      t.occurred_on,
      t.description,
      t.kind,
      t.voided_at,
      l.direction,
      l.base_amount_minor
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    where l.account_id = ${accountId}
      and l.organization_id = ${organizationId}
      and t.voided_at is null
      and t.occurred_on >= ${from}::date
      and t.occurred_on < ${to}::date
    order by t.occurred_on, t.created_at, t.id
  `;

  const lines: LedgerLine[] = [];
  let runningBalance = openingBalance;

  for (const r of lineRows) {
    const isDebit = r.direction === 'debit';
    const amt = BigInt(r.base_amount_minor as string);
    const debitMinor = isDebit ? amt : 0n;
    const creditMinor = isDebit ? 0n : amt;

    if (acctType === 'asset' || acctType === 'expense') {
      runningBalance = runningBalance + debitMinor - creditMinor;
    } else {
      runningBalance = runningBalance + creditMinor - debitMinor;
    }

    lines.push({
      date: typeof r.occurred_on === 'string' ? r.occurred_on.slice(0, 10) : String(r.occurred_on).slice(0, 10),
      description: (r.description as string) || '',
      kind: r.kind as string,
      debitMinor,
      creditMinor,
      balanceMinor: runningBalance,
    });
  }

  return {
    accountCode: account.code as string,
    accountNameEn: (account.name_en as string | null) ?? null,
    accountNameZh: (account.name_zh as string | null) ?? null,
    lines,
    openingBalance,
    closingBalance: runningBalance,
  };
}
