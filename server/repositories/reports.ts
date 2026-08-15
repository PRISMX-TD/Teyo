import type { Tx } from '@/server/db/transaction';
import { toIsoDate } from '@/lib/format';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type TrialBalanceRow = {
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  type: AccountType;
  isActive: boolean;
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
  isActive: boolean;
  totalMinor: bigint;
};

type AssetOrLiabilityOrEquity = 'asset' | 'liability' | 'equity';

/**
 * 试算平衡表：每个科目的借/贷方发生额汇总。
 *
 * 先用内连接子查询把作废与截止日期条件做在 journal_lines/transactions 上
 * （内连接才能让这两个条件真正生效——挂在 LEFT JOIN 的 ON 子句上对驱动表
 * 不起过滤作用），按科目聚合出 movement；再 LEFT JOIN 回 accounts，
 * 保留零余额科目。where 的后半段 `a.is_active or 有余额` 保留仍有余额的
 * 归档科目（I10），只丢弃真正零余额的归档科目。
 */
export async function getTrialBalance(
  tx: Tx,
  organizationId: string,
  asOf: string,
): Promise<TrialBalanceRow[]> {
  const rows = await tx`
    with movement as (
      select
        l.account_id,
        sum(case when l.direction = 'debit'  then l.base_amount_minor else 0 end) as debit,
        sum(case when l.direction = 'credit' then l.base_amount_minor else 0 end) as credit
      from journal_lines l
      join transactions t on t.id = l.transaction_id
      where l.organization_id = ${organizationId}
        and t.voided_at is null
        and t.occurred_on <= ${asOf}::date
      group by l.account_id
    )
    select
      a.code, a.name_en, a.name_zh, a.type, a.is_active,
      coalesce(m.debit, 0)  as debit,
      coalesce(m.credit, 0) as credit
    from accounts a
    left join movement m on m.account_id = a.id
    where a.organization_id = ${organizationId}
      and (a.is_active or coalesce(m.debit, 0) <> coalesce(m.credit, 0))
    order by a.sort_order, a.id
  `;

  return rows.map((r) => ({
    code: r.code as string,
    nameEn: (r.name_en as string | null) ?? null,
    nameZh: (r.name_zh as string | null) ?? null,
    type: r.type as AccountType,
    isActive: r.is_active as boolean,
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
 * 只算未作废交易。
 * 期间为闭区间 [from, to]，与资产负债表的 asOf 语义一致。
 * 两者口径必须相同，否则当天记录的交易会进资产负债表而不进损益表，
 * 使两张报表在当天必然不平。
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
      and t.occurred_on <= ${to}::date
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
  equityTotal: bigint;          // 不含本年利润
  currentYearEarnings: bigint;  // 合成行，独立于 equityTotal
};

/**
 * 资产负债表：资产 = 负债 + 权益 + 本年利润。
 *
 * 与 getTrialBalance 同样的写法：先用内连接子查询把作废与截止日期条件做在
 * journal_lines/transactions 上（内连接才能让这两个条件真正生效——挂在
 * LEFT JOIN 的 ON 子句上对驱动表不起过滤作用），按科目聚合出 movement；
 * 再 LEFT JOIN 回 accounts。where 的后半段 `a.is_active or 有余额` 保留
 * 仍有余额的归档科目（I10），只丢弃真正零余额的归档科目。
 *
 * 余额定义：
 * - 资产类：借方合计 - 贷方合计（正常余额在借方）
 * - 负债/权益类：贷方合计 - 借方合计（正常余额在贷方）
 *
 * 「本年利润」是合成行，不是科目：它不产生分录、不落库，
 * 由调用方传入的当期损益结果原样带出。年结（把它转入留存收益）在阶段 6。
 *
 * 因此平衡等式是 资产 = 负债 + 权益 + 本年利润，
 * 而不是把利润并进权益后再比较。
 */
export async function getBalanceSheet(
  tx: Tx,
  organizationId: string,
  asOf: string,
  currentYearEarnings: bigint,
): Promise<BalanceSheetResult> {
  const rows = await tx`
    with movement as (
      select
        l.account_id,
        sum(case when l.direction = 'debit'  then l.base_amount_minor else 0 end) as debit,
        sum(case when l.direction = 'credit' then l.base_amount_minor else 0 end) as credit
      from journal_lines l
      join transactions t on t.id = l.transaction_id
      where l.organization_id = ${organizationId}
        and t.voided_at is null
        and t.occurred_on <= ${asOf}::date
      group by l.account_id
    )
    select
      a.code, a.name_en, a.name_zh, a.type, a.is_active,
      coalesce(m.debit, 0)  as debit,
      coalesce(m.credit, 0) as credit
    from accounts a
    left join movement m on m.account_id = a.id
    where a.organization_id = ${organizationId}
      and a.type in ('asset', 'liability', 'equity')
      and (a.is_active or coalesce(m.debit, 0) <> coalesce(m.credit, 0))
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

    const row: BalanceSheetRow = {
      code: r.code as string,
      nameEn: (r.name_en as string | null) ?? null,
      nameZh: (r.name_zh as string | null) ?? null,
      type,
      isActive: r.is_active as boolean,
      totalMinor,
    };

    if (type === 'asset') assetRows.push(row);
    else if (type === 'liability') liabilityRows.push(row);
    else equityRows.push(row);
  }

  const assetTotal = assetRows.reduce((sum, r) => sum + r.totalMinor, 0n);
  const liabilityTotal = liabilityRows.reduce((sum, r) => sum + r.totalMinor, 0n);
  const equityTotal = equityRows.reduce((sum, r) => sum + r.totalMinor, 0n);

  return {
    assetRows,
    liabilityRows,
    equityRows,
    assetTotal,
    liabilityTotal,
    equityTotal,
    currentYearEarnings,
  };
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
  /** 三个分类都没有覆盖到的现金变动——见下方 unclassified 的计算注释。 */
  unclassified: bigint;
  netChange: bigint;
  openingCash: bigint;
  closingCash: bigint;
};

/**
 * 间接法现金流量表。
 *
 * 从净利润出发，加减非现金项目和营运资金变动，得到经营活动现金流。
 * 投资活动按科目上的 cash_flow_category 分类聚合（Task 10），不再依赖
 * 字面量 code 匹配——用户自建的资产科目也能被正确归类。
 * 融资活动仍是三行显式构造（capital/loans/ownersDraw），因为它们各自
 * 的符号规则不同，逐条明写比分类聚合更不容易出错。
 *
 * 期间口径：与 getProfitLoss（Task 8）一致的闭区间 [from, to]。
 * 期初现金取严格小于 from 的余额，与期间流量的 >= from 互补，
 * 避免 from 当天的交易被两边重复计入；期末现金取小于等于 to 的余额，
 * 与期间流量的 <= to 对齐。
 *
 * unclassified（补充调节行）：
 * 经营/投资/融资三段只覆盖了已知字面量 code 和已打上 cash_flow_category
 * 标签的科目。种子科目里的 tax-payable（打了 'operating' 标签但没有任何
 * 查询项读它）、故意留 NULL 的 retained-earnings，以及所有用户自建科目
 * （insertAccount 从不写 cash_flow_category）都不在覆盖范围内——手工记账
 * 分录可以任意选科目做对方科目，"Dr 现金 / Cr 留存收益" 这类最普通的开
 * 帐分录就足以在三段分类之外产生现金变动。与其让这部分缺口悄悄导致
 * openingCash + netChange !== closingCash（界面上表现为一条无法解释的
 * "不平" 提示），不如显式算出这个残差并把它计入 netChange、单独命名展示：
 * unclassified = (closingCash - openingCash) - (operatingTotal + investingTotal + financingTotal)。
 * 这样 tie-out 恒成立，但缺口不会被隐藏，而是被诚实地摆在一行上。
 */
export async function getCashFlow(
  tx: Tx,
  organizationId: string,
  from: string,
  to: string,
): Promise<CashFlowResult> {
  // --- 辅助：单科目期间发生额（本位币，借正贷负）。闭区间 [from, to]，
  // 与 getProfitLoss 的口径一致——否则同一笔发生在 to 当天、影响净利润的
  // 分录会在这里被漏掉，导致 operatingTotal 与 netIncome 的口径不一致。 ---
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
        and t.occurred_on <= ${to}::date
    `;
    return BigInt(r[0].net as string);
  }

  // --- 辅助：资金账户（is_money_account = true）截至某日的余额之和。
  // 按标志位聚合而不是按 'cash'/'bank' 字面量编码，用户自建的银行账户
  // 也会被正确计入期初/期末现金。 ---
  async function moneyBalanceAsOf(asOf: string, inclusive: boolean): Promise<bigint> {
    const r = inclusive
      ? await tx`
          select coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                                   else -l.base_amount_minor end), 0) as net
          from journal_lines l
          join transactions t on t.id = l.transaction_id
          join accounts a on a.id = l.account_id
          where l.organization_id = ${organizationId}
            and a.is_money_account
            and t.voided_at is null
            and t.occurred_on <= ${asOf}::date
        `
      : await tx`
          select coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                                   else -l.base_amount_minor end), 0) as net
          from journal_lines l
          join transactions t on t.id = l.transaction_id
          join accounts a on a.id = l.account_id
          where l.organization_id = ${organizationId}
            and a.is_money_account
            and t.voided_at is null
            and t.occurred_on < ${asOf}::date
        `;
    return BigInt(r[0].net as string);
  }

  // --- 辅助：按 cash_flow_category 聚合的期间发生额，逐科目返回。 ---
  async function netFlowByCategory(
    category: 'operating' | 'investing' | 'financing',
  ): Promise<{ code: string; net: bigint }[]> {
    const rows = await tx`
      select a.code,
        coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                          else -l.base_amount_minor end), 0) as net
      from journal_lines l
      join transactions t on t.id = l.transaction_id
      join accounts a on a.id = l.account_id
      where l.organization_id = ${organizationId}
        and a.cash_flow_category = ${category}
        and t.voided_at is null
        and t.occurred_on >= ${from}::date
        and t.occurred_on <= ${to}::date
      group by a.code
      order by a.code
    `;
    return rows.map((r) => ({ code: r.code as string, net: BigInt(r.net as string) }));
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
  // AP 是贷方余额科目：netFlow 是"借方减贷方"，AP 增加时 netFlow 为负，
  // 而 AP 增加（欠着还没付）对现金的影响是正——取反。
  const apChange = -(await netFlow('accounts-payable'));
  // Inventory 增加 = 现金减少（借买存货）
  const invChange = -(await netFlow('inventory'));

  // 递延收入同为贷方余额科目，符号规则与 AP 相同，取反。
  const deferredRevChange = -(await netFlow('deferred-revenue'));
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

  // --- 投资活动：按 cash_flow_category = 'investing' 聚合，不再逐个字面量
  // code 匹配——用户自建的资产科目（只要打上了该分类）也会出现在这里。
  // 资产科目增加意味着现金流出，取负。 ---
  const investingRows = (await netFlowByCategory('investing')).map((r) => ({
    label: r.code,
    amountMinor: -r.net,
  }));
  const investingTotal = investingRows.reduce((sum, r) => sum + r.amountMinor, 0n);
  const investing: CashFlowSection = { label: 'Investing', rows: investingRows };

  // --- 融资活动：保留三行显式构造，因为符号规则彼此不同，逐条明写比
  // 按分类聚合更不容易出错。 ---
  // capital/loans 都是贷方余额科目，同 AP：netFlow 借正贷负，取反。
  const capital = -(await netFlow('capital'));
  const loans = -(await netFlow('loans'));
  // owners-draw 是借方余额科目（所有者提取）：netFlow 增加时为正，
  // 而提取会减少现金，取反——与之前一致，未改动。
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

  // 期初现金：严格小于 from，与期间流量（>= from）互补，避免边界当天
  // 被两边重复计入。期末现金：小于等于 to，与期间流量（<= to）对齐。
  // 按 is_money_account 聚合，不再按 'cash'/'bank' 字面量编码。
  const openingCash = await moneyBalanceAsOf(from, false);
  const closingCash = await moneyBalanceAsOf(to, true);

  // 三段分类没能解释的现金变动——见函数顶部注释。按定义补足残差，
  // 使 openingCash + netChange === closingCash 恒成立，不平永远不会
  // 是"经营/投资/融资没加起来"，只会是这一行有非零值。
  const unclassified =
    (closingCash - openingCash) - (operatingTotal + investingTotal + financingTotal);

  const netChange = operatingTotal + investingTotal + financingTotal + unclassified;

  return {
    operating,
    investing,
    financing,
    unclassified,
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
  /** 期间内符合条件的分录总数（不受 limit/offset 影响），用于让调用方判断 lines 是否被截断。 */
  total: number;
};

/** 总账单页行数上限。limit 来自用户输入，无上界即为 30 秒函数超时下最先失败的报表。 */
export const GENERAL_LEDGER_PAGE_MAX = 500;

/**
 * 单科目的总账——按日期的分录列表 + 递进余额。
 *
 * 期间口径：闭区间 [from, to]，与 getTrialBalance/getBalanceSheet/getProfitLoss/
 * getCashFlow 一致——`to` 当天的分录必须计入，否则总账会比同一截止日期的
 * 试算平衡表少算最后一天，两份报表的期末余额就会对不上。
 * 期间分录（lines）按 limit/offset 分页；未传 options 时取默认页（上限 500 行）。
 * closingBalance 和 total 都由独立的、不受 limit/offset 影响的聚合查询算出
 * （与 openingBalance 同样的写法），所以即使 lines 被截断，closingBalance
 * 依然是整个期间的真实期末余额，不会把「已取回部分的余额」冒充成期末余额。
 * 调用方可以用 `total > lines.length` 判断本页是否发生了截断
 * （目前唯一的调用方 general-ledger/page.tsx 不传 options，尚未处理这一信号，
 * 由 general-ledger-view.tsx 负责把截断展示给用户）。
 */
export async function getGeneralLedger(
  tx: Tx,
  organizationId: string,
  accountId: string,
  from: string,
  to: string,
  options?: { limit?: number; offset?: number },
): Promise<LedgerResult> {
  const limit = options?.limit ?? GENERAL_LEDGER_PAGE_MAX;
  const offset = options?.offset ?? 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > GENERAL_LEDGER_PAGE_MAX) {
    throw new Error(`General ledger limit must be between 1 and ${GENERAL_LEDGER_PAGE_MAX}.`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('General ledger offset must be a non-negative integer.');
  }

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
      and t.occurred_on <= ${to}::date
    order by t.occurred_on, t.created_at, t.id
    limit ${limit}
    offset ${offset}
  `;

  // 期间发生额合计 + 行数——同一个 where 谓词（account_id / organization_id /
  // voided_at / occurred_on 区间）与上面的 lineRows 完全一致，但不带
  // limit/offset，这样 closingBalance 和 total 都不受分页影响。
  const periodRows = await tx`
    select
      coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                        else -l.base_amount_minor end), 0) as net,
      count(*) as total
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    where l.account_id = ${accountId}
      and l.organization_id = ${organizationId}
      and t.voided_at is null
      and t.occurred_on >= ${from}::date
      and t.occurred_on <= ${to}::date
  `;
  let periodNet = BigInt(periodRows[0].net as string);
  const total = Number(periodRows[0].total as string);
  if (acctType === 'liability' || acctType === 'equity' || acctType === 'revenue') {
    periodNet = -periodNet;
  }
  const closingBalance = openingBalance + periodNet;

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
      // postgres.js 把 date 列解析成 Date 对象而不是字符串——旧代码在这个分支
      // 用 String(r.occurred_on) 兜底，产出的是 `Thu Aug 06 2026 ...` 这种
      // JS 默认格式而不是 ISO 日期，总账页面因此把每一行的日期都显示错了。
      // 复用 toIsoDate（与 guard.ts 的 toDateOnly 同一个坑、同一个修法）
      // 正确处理 Date | string 两种情况。
      date: toIsoDate(r.occurred_on as Date | string),
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
    closingBalance,
    total,
  };
}
