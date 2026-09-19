import type { Tx } from '@/server/db/transaction';
// 科目代码不在这里写字符串字面量：一个拼错的 code 在运行时只表现为
// 「这一侧恒为零」，看不出是谁拼错的——而「进项恒为 0」正是本次要修的那个
// 缺陷长的样子。见 server/services/posting-accounts.ts 上同样的理由。
import { POSTING_ACCOUNT_CODES } from '@/server/services/account-seed';

export type TaxRateRow = {
  id: string;
  organizationId: string;
  nameEn: string;
  nameZh: string;
  rateBps: number;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
};

/**
 * 税务报表的一侧（销项或进项）。全部金额都是**本位币最小单位**。
 */
export type TaxSideTotals = {
  /**
   * 计税基数：与税科目同一笔交易里的收入（销项）/ 费用（进项）净额。
   *
   * 只数「确实产生了税的那些交易」的收入或费用。零税率与免税的销售因此
   * 不在这个数里——一张完整的税表还需要单列「零税率 / 免税供应」，那需要
   * 在科目或分类上标出免税属性，今天的数据模型里没有这个信息。已在交付
   * 报告中列明。
   */
  netMinor: bigint;
  /** 税额：税科目在本期的净发生额，只数背后有计税基数的那一部分。 */
  taxMinor: bigint;
  /**
   * 税科目上动了、但同一笔交易里找不到任何收入/费用行的那一部分。
   *
   * 最典型的就是**向税局缴税**：借待缴税款 / 贷银行。它让 tax-payable 的
   * 余额减少，但它不是一笔销售退回，不该冲减本期销项。把它并进 taxMinor
   * 会让缴过税的月份销项凭空变小；直接丢掉又等于静默吞掉一笔真实发生的
   * 科目变动。所以单列出来：taxMinor + unmatchedTaxMinor 恒等于该税科目
   * 本期的净发生额，读报表的人自己就能把两者对上。
   */
  unmatchedTaxMinor: bigint;
};

export type TaxReport = {
  outputTax: TaxSideTotals;
  inputTax: TaxSideTotals;
  /** 应缴税款 = 销项 - 进项（本位币）。 */
  netPayableMinor: bigint;
};

function mapTaxRate(row: Record<string, unknown>): TaxRateRow {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    nameEn: row.name_en as string,
    nameZh: row.name_zh as string,
    rateBps: Number(row.rate_bps),
    isDefault: row.is_default as boolean,
    isActive: row.is_active as boolean,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function listTaxRates(
  tx: Tx,
  organizationId: string,
): Promise<TaxRateRow[]> {
  const rows = await tx`
    select id, organization_id, name_en, name_zh, rate_bps, is_default, is_active, created_at
    from tax_rates
    where organization_id = ${organizationId} and is_active = true
    order by is_default desc, name_en
  `;
  return rows.map(mapTaxRate);
}

export async function insertTaxRate(
  tx: Tx,
  row: {
    organizationId: string;
    nameEn: string;
    nameZh: string;
    rateBps: number;
    isDefault: boolean;
  },
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into tax_rates (organization_id, name_en, name_zh, rate_bps, is_default)
    values (${row.organizationId}, ${row.nameEn}, ${row.nameZh}, ${row.rateBps}, ${row.isDefault})
    returning id
  `;
  return { id: inserted[0].id as string };
}

export async function updateTaxRate(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: {
    nameEn?: string;
    nameZh?: string;
    rateBps?: number;
    isDefault?: boolean;
  },
): Promise<void> {
  const sets: Record<string, unknown> = {};
  if (fields.nameEn !== undefined) sets.name_en = fields.nameEn;
  if (fields.nameZh !== undefined) sets.name_zh = fields.nameZh;
  if (fields.rateBps !== undefined) sets.rate_bps = fields.rateBps;
  if (fields.isDefault !== undefined) sets.is_default = fields.isDefault;

  const keys = Object.keys(sets);
  if (keys.length === 0) return;

  await tx`
    update tax_rates set ${tx(sets as Record<string, never>)}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function setDefaultTaxRate(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    update tax_rates set is_default = false
    where organization_id = ${organizationId} and is_default = true
  `;
  await tx`
    update tax_rates set is_default = true
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function deleteTaxRate(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  const rateRows = await tx`
    select rate_bps from tax_rates
    where id = ${id} and organization_id = ${organizationId}
  `;
  if (rateRows.length === 0) return;

  const rateBps = Number(rateRows[0].rate_bps);

  const refs = await tx`
    select count(*)::int as cnt from invoices
    where organization_id = ${organizationId}
      and tax_rate_bps = ${rateBps}
      and voided_at is null
  `;
  if (Number(refs[0].cnt) > 0) {
    throw new Error('This tax rate is used by one or more invoices and cannot be deleted.');
  }

  await tx`
    update tax_rates set is_active = false
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/**
 * 销项与进项的税额汇总。**两侧都从分录聚合，不从单据表聚合。**
 *
 * ------------------------------------------------------------
 * 原来是什么样
 * ------------------------------------------------------------
 * 销项 sum(invoices.subtotal_minor / tax_minor)，进项写死
 *   sum(b.total_minor) as net_minor, 0::bigint as tax_minor
 * 进项恒为 0（bills 表当时没有税额列），于是「应缴税款 = 销项 - 进项」这句
 * 话在这个产品里无法成立：用户看到的应缴税额永远偏高，高出来的正好是他本
 * 可以抵扣的全部进项。净额取的还是含税总额，税基也是错的。
 *
 * ------------------------------------------------------------
 * 为什么改成从分录聚合，而不是「给单据查询补上税额列和状态过滤」
 * ------------------------------------------------------------
 * 后者是最小改动，但它有四件事修不掉：
 *
 * 1. **草稿会被算进去。** 发票有了真正的 draft/sent 生命周期之后，draft 是
 *    不进总账、可以随便改、也可能永远不发出去的东西。而按单据聚合时唯一的
 *    过滤条件是 voided_at——一张从未开具的草稿照样贡献销项税，用户拿这个数
 *    去报税，报的是一笔根本不存在的销售。从分录聚合则天然只数已经入账的。
 * 2. **贷项通知单冲减不了销项。** 销售退回会冲减销项税，但它在 invoices 表
 *    里没有行。它在分录里有：借销售收入 / 借销项税 / 贷应收（见
 *    posting-templates.ts 的 credit-note）。
 * 3. **作废是两个字段。** 单据侧看 invoices.voided_at，分录侧看
 *    transactions.voided_at，两者可能不同步。税表读的是账，就该以账的
 *    作废标记为准。
 * 4. **外币税额是原币。** invoices.tax_minor 是单据币种下的数，而 invoices
 *    与 bills 上既没有 exchange_rate 也没有 base_amount_minor（payments /
 *    credit_notes / purchase_orders 三张表都有，唯独这两张没有，0021 也没补）。
 *    从单据聚合就必须自己再写一遍换算——又一份手抄的实现。
 *    journal_lines.base_amount_minor 是记账边界当时就算好的本位币金额。
 *
 * 更根本的理由：这让税表与总账**同源**。「同一笔钱在两个地方各算一遍」正是
 * 这个项目已经出过一次的那类 bug 的形状（应收账龄表说客户欠钱、资产负债表
 * 说应收为零）。
 *
 * ------------------------------------------------------------
 * 代价：按税率拆行没有了
 * ------------------------------------------------------------
 * 分录上没有税率——税率是单据的属性。要拆行就得 join 回 invoices/bills，
 * 而那会把上面刚刚解开的耦合又接回去（且贷项通知单与手工凭证根本 join 不到）。
 * 今天没有任何页面消费这个函数（全仓 grep 只有 server/actions/tax.ts 调它），
 * 也就没有「报表必须按税率拆行」这个需求存在的证据。少一个耦合。
 * 真要拆行时，正确的做法是让税率进分录（给 journal_lines 加一列，一条迁移），
 * 而不是让报表同时依赖两个数据源。已在交付报告中列明。
 *
 * 顺带的好处：这个实现**不依赖尚未执行的 0021**。tax-receivable 科目由
 * seedChartOfAccounts 给新公司写入、由 0021 回填给老公司；科目还不存在的
 * 公司在这里只是聚合到零行，进项为 0——与迁移前的事实一致（那时确实没有
 * 任何一笔进项税入过账），不是伪造出来的数。
 *
 * 期间口径与 reports.ts 的 getProfitLoss 一致：闭区间 [from, to]，
 * t.voided_at is null。
 */
export async function getTaxReport(
  tx: Tx,
  organizationId: string,
  from: string,
  to: string,
): Promise<TaxReport> {
  const outputTax = await sideTotals(tx, organizationId, from, to, {
    taxAccountCode: POSTING_ACCOUNT_CODES.outputTax,
    baseAccountType: 'revenue',
    // 销项税是负债，贷方增加；对应的收入也在贷方。
    positiveDirection: 'credit',
  });

  const inputTax = await sideTotals(tx, organizationId, from, to, {
    taxAccountCode: POSTING_ACCOUNT_CODES.inputTax,
    baseAccountType: 'expense',
    // 进项税是资产，借方增加；对应的费用也在借方。
    positiveDirection: 'debit',
  });

  return {
    outputTax,
    inputTax,
    netPayableMinor: outputTax.taxMinor - inputTax.taxMinor,
  };
}

/**
 * 一侧（销项或进项）的三个数。
 *
 * 两步，都在同一条 SQL 里：
 *   tax_txns —— 本期内、未作废、动过这个税科目的每一笔交易，以及它在这个
 *               科目上的净发生额；
 *   base     —— 这些交易里收入（或费用）科目的净发生额，也就是计税基数。
 *
 * 然后按「这笔交易有没有计税基数」把税额分成两堆：有的进 taxMinor，
 * 没有的进 unmatchedTaxMinor。两堆之和恒等于该科目本期的净发生额，
 * 所以没有任何一分钱被静默吞掉——见 TaxSideTotals.unmatchedTaxMinor。
 *
 * 判据用的是「同一笔交易里有没有收入/费用行」而不是「找不找得到对应单据」。
 * 后者要 join invoices / bills / credit_notes 三张表，其中 credit_notes 的
 * transaction_id 是 0021 才加的列，而这个函数刚刚才摆脱对 0021 的依赖。
 * 前者只读分录，判得同样准：缴税给税局那一笔（借待缴税款 / 贷银行）没有
 * 收入行，正是要单列出来的那一种。
 */
async function sideTotals(
  tx: Tx,
  organizationId: string,
  from: string,
  to: string,
  spec: {
    taxAccountCode: string;
    baseAccountType: 'revenue' | 'expense';
    positiveDirection: 'debit' | 'credit';
  },
): Promise<TaxSideTotals> {
  const [row] = await tx`
    with tax_txns as (
      select
        jl.transaction_id,
        sum(
          case when jl.direction = ${spec.positiveDirection}
               then jl.base_amount_minor else -jl.base_amount_minor end
        ) as tax_minor
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join transactions t on t.id = jl.transaction_id
      where jl.organization_id = ${organizationId}
        and a.code = ${spec.taxAccountCode}
        and t.voided_at is null
        and t.occurred_on >= ${from}::date
        and t.occurred_on <= ${to}::date
      group by jl.transaction_id
    ),
    base as (
      select
        jl.transaction_id,
        sum(
          case when jl.direction = ${spec.positiveDirection}
               then jl.base_amount_minor else -jl.base_amount_minor end
        ) as net_minor
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      where jl.organization_id = ${organizationId}
        and a.type = ${spec.baseAccountType}
        and jl.transaction_id in (select transaction_id from tax_txns)
      group by jl.transaction_id
    )
    select
      coalesce(sum(coalesce(b.net_minor, 0)), 0) as net_minor,
      coalesce(sum(case when b.transaction_id is not null then tt.tax_minor else 0 end), 0)
        as tax_minor,
      coalesce(sum(case when b.transaction_id is null then tt.tax_minor else 0 end), 0)
        as unmatched_tax_minor
    from tax_txns tt
    left join base b on b.transaction_id = tt.transaction_id
  `;

  return {
    netMinor: BigInt(row.net_minor as string),
    taxMinor: BigInt(row.tax_minor as string),
    unmatchedTaxMinor: BigInt(row.unmatched_tax_minor as string),
  };
}
