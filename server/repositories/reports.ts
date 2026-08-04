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
