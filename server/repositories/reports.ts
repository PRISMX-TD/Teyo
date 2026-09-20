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
 *
 * ============================================================
 * 为什么**只有这张表**排除 kind = 'closing'
 * ============================================================
 * 年结分录（见 server/services/year-end-close.ts）按会计惯例记在财年最后
 * 一天，内容是把每个收入、费用科目的余额冲平、差额进留存收益。它落在这张
 * 表的期间里，而它恰好把这张表要聚合的每一个科目都清成零——照常算的话，
 * **刚刚结转过的那一年的损益表会变成全零**。用户第二年回头看去年赚了多少，
 * 会看到一张什么都没有的表，而每一行都"正确"。
 *
 * 另外三张表必须**包含**它，理由各不相同，不是「顺手一起排除」：
 *   - 试算平衡表（getTrialBalance）：它是全部分录的借贷合计，漏掉任何一笔
 *     都会让借贷两边不等（I6 当场变红）。
 *   - 资产负债表（getBalanceSheet）：留存收益的余额**就是**靠这笔分录来的。
 *     排除它等于年结从未发生，上一年的利润会再次凭空消失。
 *   - 总账（getGeneralLedger）：查 retained-earnings 这个科目的人，要看的
 *     正是这几笔结转；把它藏起来，那个科目的余额就没有任何分录解释得了。
 * tests/repositories/reports-closing.test.ts 把这四条口径逐个钉住。
 *
 * 现金流量表（getCashFlow）间接法以 netIncome 起步，而 netIncome 来自这个
 * 函数，所以它自动继承了这里的排除；年结分录的另一条腿是留存收益，那个
 * 科目的 cash_flow_category 是 NULL（见 account-seed.ts），既不在三段分类里
 * 也不是资金账户，因此它对现金流量表的净影响恒为零，不会掉进 unclassified
 * 那条残差行。
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
      and t.kind <> 'closing'
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

/** 年结要冲平的一个损益科目。netMinor 是「借方合计 - 贷方合计」，带符号。 */
export type ClosingBalanceRow = {
  accountId: string;
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  type: 'revenue' | 'expense';
  netMinor: bigint;
};

/**
 * 财年内每个损益科目的净发生额，供 server/services/year-end-close.ts 构造
 * 年结分录。
 *
 * 与 getProfitLoss 的区别只有两处，但两处都是必需的：
 *   1. 带 accountId。getProfitLoss 只返回 code——那是给人看的报表，而记账
 *      要的是 id：分录行落的是 account_id，按 code 反查一遍等于多一处可能
 *      查错公司的地方。
 *   2. 返回带符号的净额，不按科目类型翻正负号。年结的方向要按**这个科目
 *      此刻挂在哪一侧**决定，而不是按它「正常」挂在哪一侧——一个带借方
 *      余额的收入科目（销售退回、或者一笔记反了又红字冲回）必须被贷才能
 *      归零。getProfitLoss 那种「收入取贷减借」的翻转会把符号信息抹掉。
 *
 * 其余口径与 getProfitLoss 逐字相同：本位币、未作废、闭区间 [from, to]、
 * 排除 kind = 'closing'。最后一条尤其重要——撤销重做时，上一次年结的分录
 * 已经作废（voided_at 非空）所以本来就不会进来；但如果哪天改成硬删或别的
 * 撤销方式，这一句仍然保证不会拿「上一次结转的结果」再结一次。
 */
export async function getYearEndClosingBalances(
  tx: Tx,
  organizationId: string,
  from: string,
  to: string,
): Promise<ClosingBalanceRow[]> {
  const rows = await tx`
    select
      a.id, a.code, a.name_en, a.name_zh, a.type,
      coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                        else -l.base_amount_minor end), 0) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    join accounts a on a.id = l.account_id
    where l.organization_id = ${organizationId}
      and t.voided_at is null
      and t.kind <> 'closing'
      and t.occurred_on >= ${from}::date
      and t.occurred_on <= ${to}::date
      and (a.type = 'revenue' or a.type = 'expense')
    group by a.id, a.code, a.name_en, a.name_zh, a.type, a.sort_order
    order by a.sort_order, a.id
  `;

  return rows.map((r) => ({
    accountId: r.id as string,
    code: r.code as string,
    nameEn: (r.name_en as string | null) ?? null,
    nameZh: (r.name_zh as string | null) ?? null,
    type: r.type as 'revenue' | 'expense',
    netMinor: BigInt(r.net as string),
  }));
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
 * 由调用方传入的当期损益结果原样带出。
 *
 * 因此平衡等式是 资产 = 负债 + 权益 + 本年利润，
 * 而不是把利润并进权益后再比较。
 *
 * ============================================================
 * 年结之后这一行是什么
 * ============================================================
 * 这个函数**包含** kind = 'closing' 的分录（只有损益表排除它，理由见
 * getProfitLoss）。所以年结之后，上一年的利润已经真实地躺在
 * retained-earnings 里，被 equityRows 算进 equityTotal。
 *
 * 此时 currentYearEarnings 必须只是**本财年至今**的净利润，而不是「今年
 * 至今 + 去年」——调用方传的是 getProfitLoss(本财年起, 今天).netIncome，
 * 而那个函数排除了年结分录，所以它恰好只有本财年发生的损益。两边合起来，
 * 资产 = 负债 + 权益(含已结转的历年利润) + 本年利润(未结转的这一年) 精确
 * 成立，而且**结转前后都成立**：结转前留存收益是 0、去年的利润仍在损益
 * 科目上（如果报表期间覆盖得到），结转后它换了个位置，等式两边同时变化。
 *
 * 这也是为什么调用方必须用财年而不是日历年取 currentYearEarnings：财年
 * 7 月起的公司，如果拿 1 月 1 日当起点，1–6 月那半年的损益会被同时算进
 * 留存收益（已结转）与本年利润（期间覆盖），资产负债表恰好多出半年利润。
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
 *
 * 汇兑损益（fx-gain / fx-loss）为什么不单列一行、也不会被重复计算：
 *
 * 这两个是损益科目，已经**完整地**包含在 netIncome 里了（getProfitLoss 按
 * a.type in ('revenue','expense') 聚合，不挑 code）。给它们再加一行加回，
 * 就会把同一笔金额算两次。
 *
 * 那它们的对方科目呢？一张 1,000 USD 的发票按开票日汇率 4.0 记进应收
 * （Dr AR 4,000 / Cr sales 4,000）；收款日汇率 4.2，实收 4,200
 * （Dr Bank 4,200 / Cr AR 4,000 / Cr fx-gain 200）。在覆盖两笔的期间里：
 *   netIncome = 4,000(sales) + 200(fx-gain) = 4,200
 *   arChange  = -(4,000 - 4,000) = 0
 *   operatingTotal = 4,200，而真实现金变动也是 4,200 —— 对上了。
 * 只有收款落在本期时（发票在上期）：
 *   netIncome = 200，arChange = -(0 - 4,000) = +4,000，合计 4,200 —— 同样对上。
 * 换成先重估再收款（Dr AR 200 / Cr fx-gain 200，随后 Cr AR 4,200）结论不变。
 *
 * 一般地：净利润等于全部损益科目净额的相反数，而每一笔分录都配平，所以
 * 「净利润 + 各项非现金/营运资金调整」缺的那部分恰好是**没有被任何一段
 * 覆盖的非资金科目**的净额——汇兑损益的对方科目永远是应收/应付或资金账户，
 * 前者由 arChange/apChange 覆盖，后者本身就是现金。两边都不落在缺口里，
 * 因此 fx 不会让 unclassified 变成非零，也不会被算两次。
 * tests/repositories/reports-correctness.test.ts 里那条外币发票 → 部分收款
 * → 汇兑差额的用例把这段推理钉住了。
 */
export async function getCashFlow(
  tx: Tx,
  organizationId: string,
  from: string,
  to: string,
): Promise<CashFlowResult> {
  // --- 辅助：单科目期间发生额（本位币，借正贷负）。闭区间 [from, to]，
  // 与 getProfitLoss 的口径一致——否则同一笔发生在 to 当天、影响净利润的
  // 分录会在这里被漏掉，导致 operatingTotal 与 netIncome 的口径不一致。
  //
  // 同样要排除 kind = 'closing'，理由也是「与 netIncome 口径一致」：
  // 这个辅助函数被 depreciation / amortization 两项读，而它们是**费用科目**，
  // 年结分录恰好把它们冲平。netIncome 已经排除了年结（见 getProfitLoss），
  // 如果这里不排除，结转过的那一年折旧加回项会变成 0——operatingTotal 少掉
  // 一整年的折旧，那一截会原样掉进下面的 unclassified 残差行，变成一个
  // 谁也解释不了的数字。其余被读的 code（应收、应付、存货、税、股本…）
  // 年结分录根本不碰，这一句对它们是恒等的。 ---
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
        and t.kind <> 'closing'
        and t.occurred_on >= ${from}::date
        and t.occurred_on <= ${to}::date
    `;
    return BigInt(r[0].net as string);
  }

  // --- 辅助：资金账户（is_money_account = true）截至某日的余额之和。
  // 按标志位聚合而不是按 'cash'/'bank' 字面量编码，用户自建的银行账户
  // 也会被正确计入期初/期末现金。
  //
  // 这一个**不**排除 kind = 'closing'，与上面两个辅助函数相反：这里算的是
  // 「账上到那一天有多少钱」，必须与资产负债表上的资金科目逐分相等，而
  // 资产负债表包含全部未作废分录。真要有一笔年结分录碰了资金账户（今天
  // buildClosingPlan 只碰损益科目与留存收益，所以不会），把它藏起来只会让
  // 两张报表对同一个银行账户给出两个余额。 ---
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
        -- 与 netFlow 同一个理由。今天只被 'investing' 调用，而投资类全是
        -- 资产科目、年结不碰，所以这一句是恒等的；写上是为了让「年结分录
        -- 不进现金流量表的任何一段」成为结构性事实，而不是一个恰好成立的
        -- 巧合——下一个人把经营段也改成按分类聚合时（经营段里全是年结要
        -- 冲平的损益科目），漏掉这一句就会重演上面那条注释里的故障。
        and t.kind <> 'closing'
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

  // 税款两侧。种子科目里 tax-payable 与（0021 补的）tax-receivable 都打了
  // cashFlowCategory = 'operating' 的标签，但**没有任何查询项读它们**：
  // netFlowByCategory 只被 'investing' 调用过一次，经营段全部是字面量 code。
  // 于是这两个科目的现金变动一直整批落进 unclassified 残差行——单据接进
  // 总账之后，含税发票/账单会让它们第一次有真实余额，那条残差行会突然
  // 冒出一个谁也解释不了的数字。
  //
  // 符号规则按科目类型，不按名字里有没有 tax：
  // - tax-payable 是负债（销项税，欠税务局的），与 AP 同侧：欠着还没缴，
  //   现金留在手上，取反后为正；
  // - tax-receivable 是资产（进项税，可以抵扣/退回的），与 AR 同侧：
  //   多付出去的钱还没收回来，取反后为负。
  const taxPayableChange = -(await netFlow('tax-payable'));
  const taxReceivableChange = -(await netFlow('tax-receivable'));

  const operatingTotal = netIncome
    + depreciation
    + amortization
    + arChange
    + apChange
    + invChange
    + deferredRevChange
    + prepaidChange
    + taxPayableChange
    + taxReceivableChange;

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
      { label: 'taxPayableChange', amountMinor: taxPayableChange },
      { label: 'taxReceivableChange', amountMinor: taxReceivableChange },
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
