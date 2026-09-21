import type { Tx } from '@/server/db/transaction';

/**
 * 无法换算成本位币而被排除在账龄桶之外的单据。见 getArAging 顶部
 * 「三、换不出本位币的单据怎么办」一节。
 */
export type AgingNotice = {
  /** 被排除的单据数。 */
  count: number;
  /** 这些单据的币种，去重后按字母序。 */
  currencies: string[];
};

export type ArAgingRow = {
  contactId: string;
  contactName: string;
  /** 尚未到期（到期日 >= asOf）。 */
  current: bigint;
  /** 逾期 1-30 天。 */
  d1_30: bigint;
  d31_60: bigint;
  d61_90: bigint;
  over90: bigint;
  total: bigint;
  /**
   * 已逾期（到期日严格早于 asOf）的未结余额，本位币。
   *
   * 自从 `current` 只装「尚未到期」之后，这个数等于 total - current，也等于
   * 后四个桶之和。保留它是因为 dashboard 的 overdueInvoices / overdueBills
   * 直接取它——「逾期」在整个产品里只有一处定义，各处自己去加桶迟早会漂。
   *
   * （在此之前它确实**不**等于 total - current：`current` 桶当时把「逾期
   * 30 天以内」也算在内，于是表头写着「未逾期」的那一列里躺着已经欠了一个月
   * 的钱。i18n 里 days30 这个键一直存在却从没被用过，说明第五个桶本来就是
   * 打算做的。）
   */
  overdue: bigint;
  /**
   * 普通行为 null。只有末尾那条「有单据换不出本位币」的提示行不为 null，
   * 且它的金额字段全是 0——见 getArAging 的注释。
   */
  notice: AgingNotice | null;
};

export type ApAgingRow = ArAgingRow;

export type StatementLine = {
  date: string;
  description: string;
  reference: string;
  amount: bigint;
  balance: bigint;
};

export type CustomerStatement = {
  openingBalance: bigint;
  lines: StatementLine[];
  closingBalance: bigint;
  /**
   * 对账单里换不出本位币、因而未被计入任何金额的单据。与账龄表同一条规则，
   * 同一个理由。
   */
  notice: AgingNotice | null;
};

function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 提示行的标签。仓储层拿不到 locale（i18n 在 components 层），所以这里写成
 * 中英双语的一行字，让两种语言的用户都读得懂它在说什么，而不是只对一半用户
 * 有意义。金额一律填 0：这样表尾的合计仍然是**纯本位币**的合计，不会因为
 * 一条提示行又把原币金额混进去——而那正是这次要修掉的毛病本身。
 */
function noticeLabel(notice: AgingNotice): string {
  const currencies = notice.currencies.join(', ');
  return `⚠ ${notice.count} 张外币单据尚未过账、无法换算成本位币，未计入本表（${currencies}）`
    + ` / ${notice.count} unposted foreign-currency document(s) excluded`;
}

/**
 * 把一条 SQL 行映射成账龄行。`contact_id` 为 null 的那一行是提示行
 * （见 agingQueryShape 的注释），它在结果里至多出现一次，永远排在最后。
 */
function mapAgingRow(row: Record<string, unknown>): ArAgingRow {
  const contactId = (row.contact_id as string | null) ?? null;

  if (contactId === null) {
    const notice: AgingNotice = {
      count: Number(row.doc_count as string),
      currencies: ((row.currencies as string[] | null) ?? []).slice().sort(),
    };
    return {
      // contactId 用空串：它是组件里 <tr key> 的取值，而提示行至多一条，
      // 空串在同一张表里必然唯一。
      contactId: '',
      contactName: noticeLabel(notice),
      current: 0n,
      d1_30: 0n,
      d31_60: 0n,
      d61_90: 0n,
      over90: 0n,
      total: 0n,
      overdue: 0n,
      notice,
    };
  }

  return {
    contactId,
    contactName: row.contact_name as string,
    current: BigInt(row.current as string),
    d1_30: BigInt(row.d1_30 as string),
    d31_60: BigInt(row.d31_60 as string),
    d61_90: BigInt(row.d61_90 as string),
    over90: BigInt(row.over90 as string),
    total: BigInt(row.total as string),
    overdue: BigInt(row.overdue as string),
    notice: null,
  };
}

/** 账龄行的本位币合计。提示行金额全是 0，加进来不影响结果。 */
export function sumAgingOutstanding(rows: readonly ArAgingRow[]): bigint {
  return rows.reduce((total, row) => total + row.total, 0n);
}

/** 账龄行的逾期合计，本位币。 */
export function sumAgingOverdue(rows: readonly ArAgingRow[]): bigint {
  return rows.reduce((total, row) => total + row.overdue, 0n);
}

/* =========================================================================
   应收账龄
   ========================================================================= */

/**
 * 应收账龄表（AR aging）。
 *
 * 原来的写法只有一句 `sum(i.total_minor) ... where status not in ('paid','voided')`，
 * 三个独立的错误叠在一起：
 *
 * 一、**不扣已收的钱**。一张收了 90% 的发票，整额落在账龄桶里。真实的
 *     催收清单因此永远偏大，而偏大的幅度取决于收了多少——没有任何规律，
 *     也没有任何提示。status 也帮不上忙：server/actions/payments.ts 收到
 *     钱之后从不回写 invoices.status，所以「付清了」这件事在 status 上
 *     根本看不出来。这次改成按**未结余额**算，顺带让这条依赖消失：
 *     余额 <= 0 的单据自然掉出结果集，不再依赖任何人记得改 status。
 *
 * 二、**不同币种的 total_minor 直接相加**。invoices.total_minor 是**原币**
 *     金额，一张 1,000 USD 的发票与一张 1,000 MYR 的发票会被加成 2,000，
 *     而组件（components/reports/reports-view.tsx 的 AgingTable）拿这个数
 *     按 baseCurrency 格式化展示——屏幕上写着 "RM 2,000.00"，而真实的应收
 *     可能是 RM 5,400。这是本项目反复在修的那一类：把原币当本位币。
 *
 * 三、**没有 as-of 上界**。asOf 只用来分桶，不用来筛单据，于是一张开在
 *     asOf 之后的发票照样出现在「今天的账龄表」里。与 dashboard 的
 *     total_bank_balance 缺日期上界是同一个毛病。
 *
 * ## 一、未结余额怎么算
 *
 *   未结（原币） = 单据总额 − 已核销收款 − 已冲抵贷项通知单
 *
 * 三项全部取**单据自己的币种**，因为只有在同一币种下这个减法才有意义。
 * 减完之后**一次性**换成本位币（见下一节），而不是三项各自换算再相减——
 * 后者的差额里会混进汇兑损益，导致一张已经全额结清的外币发票在账龄表上
 * 还挂着一个清不掉的尾数。账龄表要回答的是「这个客户还欠多少」，那是一个
 * 原币概念；汇兑损益属于损益表（fx-gain / fx-loss 科目），不属于这里。
 *
 * ## 二、怎么换成本位币
 *
 *   base = 单据本位币总额 − round(单据本位币总额 × 已结算原币 ÷ 单据原币总额)
 *
 * 写成「总额减去已结算的那部分」而不是「未结原币 × 汇率」，是为了与
 * server/services/fx-settlement.ts 的 clearedBaseMinor 用同一个公式、同一种
 * 舍入（half-up）——那个函数决定了每次结算实际冲掉多少本位币应收。两边一致，
 * 账龄表的未结额才与总账 accounts-receivable 上真正躺着的数逐分相等；
 * 先减后乘在比例恰好落在半分上时会差一个最小单位。
 *
 * 「单据的本位币总额」取自它过账产生的那笔 transactions.base_amount_minor
 * （postJournal 写表头时用的是借方合计，对发票就是应收那一行的本位币金额）。
 * 用**单据自己当初记账的汇率**，而不是今天的汇率，因为账龄表展示的是应收
 * 在账上的账面价值，与总账里 accounts-receivable 的余额同源；按今天的汇率
 * 重估是期末汇兑重估，是另一件事，这个产品还没有做。
 *
 * 换算用 numeric 做，全程不经浮点：Postgres 的 numeric 是精确十进制。
 * round() 四舍五入到整数 minor unit，结果再转回 bigint。
 *
 * ## 三、换不出本位币的单据怎么办
 *
 * 两种情况**不需要**任何汇率，因此不算「换不出」：
 *   - 单据币种 = 本位币：原币金额就是本位币金额，这是事实，不是 1:1 的假设；
 *   - 单据已过账：本位币金额直接来自它自己的分录。
 *
 * 剩下的一种——**外币且尚未过账**——是真的不知道。此时绝不能按 1:1 当本位币
 * 悄悄混进合计（那正是本项目在反复修的那类错误），于是：把它排除在账龄桶
 * 之外，并在结果末尾追加**一条提示行**，写明有几张、什么币种。金额全填 0，
 * 所以表尾合计仍然是纯本位币；缺口不会被隐藏，而是被诚实地摆在一行上——
 * 与 reports.ts 的现金流量表对 `unclassified` 残差行的处理是同一条原则。
 *
 * 为什么不抛错：抛错会让整张报表页 500，而「有几张外币发票还没过账」是一条
 * 提示，不是一场事故——其余客户的账龄仍然完全可用。这与
 * server/domain/report-invariants.ts 顶部「返回差额而不是抛错」的理由相同。
 *
 * （提示行目前只能借用「客户」那一列来显示这句话，因为 AgingTable 是既有
 * 组件、本次不在可改范围内。结构化的 notice 字段已经带出来了，日后组件愿意
 * 单独渲染它时不必再改这里。）
 *
 * ## 四、收款币种与单据币种不一致
 *
 * payment_items.amount_minor 记的是**收款单币种**下的金额
 * （server/actions/payments.ts 用 currencyExponent(payment.currency) 解析），
 * 而一张收款单只有一个币种。如果有人用 USD 收款去核销一张 MYR 发票，
 * 「单据总额 − 已核销」这个减法就是拿两种货币相减。这种单据同样被归入
 * 上面那条提示行，而不是算出一个看起来正常的错数。
 *
 * ## 五、草稿不算应收
 *
 * 原来的过滤是 `status not in ('paid','voided')`，draft 被算进去了。
 * 一张草稿发票还没有开给客户，不构成对客户的债权，也不会过账进总账——
 * 把它算进账龄表，等于保证了账龄合计与总账 accounts-receivable 余额永远
 * 对不上。
 *
 * ## 六、分桶口径
 *
 * 五个桶：未到期 / 逾期 1-30 / 31-60 / 61-90 / 90+。
 *
 * 「未到期」原来的定义是「到期日在 asOf 前 30 天之内**或**尚未到期」——
 * 也就是说，表头写着 Current 的那一列里，混着已经逾期将近一个月的钱。一份
 * 账龄表的全部用途就是回答「哪些钱该去催了」，而这个分法恰好把最该催的那
 * 一档藏进了看起来最安全的那一列。i18n 里 `days30`（1-30 天）这个键从建库
 * 起就在、却从没有被任何地方引用过，说明第五个桶本来就在计划里，只是没做。
 *
 * 现在 current 严格等于「到期日 >= asOf」，逾期部分单独成桶。边界仍然每
 * 30 天一档，四个逾期桶不重不漏地铺满 due_date < asOf，因此
 * overdue === d1_30 + d31_60 + d61_90 + over90 === total - current。
 *
 * ## 七、为什么桶与提示行在同一条 SQL 里
 *
 * 两者对「什么叫未结」「什么叫换得出」的定义必须逐字相同，否则会出现一张
 * 单据既不在桶里、也不在提示行里——凭空消失，且没有任何一处报错。写成
 * 同一个 CTE 上的两个分支（union all），定义只有一份，想漂移也漂移不了。
 */
export async function getArAging(
  tx: Tx,
  organizationId: string,
  asOf: string,
): Promise<ArAgingRow[]> {
  const rows = await tx`
    with base as (
      select base_currency from organizations where id = ${organizationId}
    ),
    paid as (
      select
        pi.invoice_id as invoice_id,
        sum(pi.amount_minor) as paid_minor,
        bool_or(p.currency <> i.currency) as currency_mismatch
      from payment_items pi
      join payments p on p.id = pi.payment_id
      join invoices i on i.id = pi.invoice_id
      where p.organization_id = ${organizationId}
        and p.voided_at is null
        and p.payment_date <= ${asOf}::date
        and pi.invoice_id is not null
      group by pi.invoice_id
    ),
    credited as (
      select
        cn.invoice_id,
        -- credit_notes.base_amount_minor 这个列名是历史遗留的误称：
        -- server/actions/credit_notes.ts 直接把明细行金额相加写进去，
        -- 一次汇率都没应用过，所以它装的其实是**原币**总额。这里正是
        -- 需要原币的地方，用它是对的；但绝不能因为列名叫 base 就把它
        -- 当本位币用（getCustomerStatement 以前就是这么用的）。
        sum(cn.base_amount_minor) as credited_minor,
        bool_or(cn.currency <> i.currency) as currency_mismatch
      from credit_notes cn
      join invoices i on i.id = cn.invoice_id
      where cn.organization_id = ${organizationId}
        and cn.voided_at is null
        and cn.status in ('issued', 'applied')
        and cn.issue_date <= ${asOf}::date
      group by cn.invoice_id
    ),
    doc as (
      select
        i.contact_id,
        i.due_date,
        i.currency,
        i.total_minor
          - coalesce(pd.paid_minor, 0)
          - coalesce(cd.credited_minor, 0) as outstanding_doc,
        (
          (
            i.currency = (select base_currency from base)
            or (t.id is not null and i.total_minor > 0)
          )
          and not coalesce(pd.currency_mismatch, false)
          and not coalesce(cd.currency_mismatch, false)
        ) as measurable,
        -- 本位币未结额 = 单据本位币总额 − 已结算部分按比例折算的本位币金额。
        --
        -- 为什么是「总额减去已结算的那部分」而不是「未结原币 × 汇率」：
        -- server/services/fx-settlement.ts 的 clearedBaseMinor 就是用
        -- proRataHalfUp(单据本位币总额, 累计已结算原币, 单据原币总额)
        -- 算出每次结算要冲掉多少本位币应收的（收款那一笔按结算日汇率记，
        -- 差额由一笔纯本位币的汇兑调整补足，两笔合起来正好等于这个比例数）。
        -- 照同一个公式反过来算剩余，账龄表的未结额就与总账
        -- accounts-receivable 上真正躺着的那个数**逐分相等**；换成先减后乘
        -- 的写法，在比例恰好落在半分上时会差 1 个最小单位。
        -- Postgres 的 round(numeric) 对正数就是 half-up，与 proRataHalfUp 同一种舍入。
        --
        -- least/greatest 把已结算额夹在 [0, 总额] 之间，与 clearedBaseMinor
        -- 里的 clamp 同理：多收一分钱不该让未结额变成负数再倒灌进合计。
        case
          when i.currency = (select base_currency from base)
            then (i.total_minor
                   - coalesce(pd.paid_minor, 0)
                   - coalesce(cd.credited_minor, 0))::bigint
          when t.id is not null and i.total_minor > 0
            then t.base_amount_minor - round(
                   t.base_amount_minor::numeric
                   * least(
                       greatest(coalesce(pd.paid_minor, 0) + coalesce(cd.credited_minor, 0), 0),
                       i.total_minor
                     )::numeric
                   / i.total_minor::numeric
                 )::bigint
          else 0::bigint
        end as outstanding_base
      from invoices i
      left join paid pd on pd.invoice_id = i.id
      left join credited cd on cd.invoice_id = i.id
      -- t.voided_at is null：单据指着一笔已作废的交易时等同于没过账。
      -- 少了这一句，一张作废重开的发票会用作废那笔分录的本位币金额来换算。
      left join transactions t
        on t.id = i.transaction_id
       and t.organization_id = ${organizationId}
       and t.voided_at is null
      where i.organization_id = ${organizationId}
        and i.voided_at is null
        and i.status not in ('draft', 'voided')
        and i.issue_date <= ${asOf}::date
    ),
    agg as (
      select
        d.contact_id,
        c.name as contact_name,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date >= ${asOf}::date
        ), 0) as current,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date < ${asOf}::date
            and d.due_date > ${asOf}::date - interval '30 days'
        ), 0) as d1_30,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date <= ${asOf}::date - interval '30 days'
            and d.due_date > ${asOf}::date - interval '60 days'
        ), 0) as d31_60,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date <= ${asOf}::date - interval '60 days'
            and d.due_date > ${asOf}::date - interval '90 days'
        ), 0) as d61_90,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date <= ${asOf}::date - interval '90 days'
        ), 0) as over90,
        coalesce(sum(d.outstanding_base), 0) as total,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date < ${asOf}::date
        ), 0) as overdue,
        0::bigint as doc_count,
        array[]::text[] as currencies
      from doc d
      join contacts c on c.id = d.contact_id
      where d.measurable and d.outstanding_doc > 0
      group by d.contact_id, c.name

      union all

      select
        null::uuid, null::text,
        -- 五个桶 + total + overdue = 7 个 0。上面那一支加了 d1_30 之后，
        -- union 两支的列数必须一起改——少一个 Postgres 会直接报列数不符，
        -- 但顺序错了它不会报，只会把 overdue 的值放进 total 那一列。
        0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
        count(*)::bigint,
        coalesce(array_agg(distinct d.currency::text), array[]::text[])
      from doc d
      where not d.measurable and d.outstanding_doc > 0
      having count(*) > 0
    )
    select * from agg
    order by (contact_id is null), total desc, contact_name
  `;

  return rows.map(mapAgingRow);
}

/* =========================================================================
   应付账龄
   ========================================================================= */

/**
 * 应付账龄表（AP aging）。与 getArAging 逐条同理，只是换成 bills / 付款。
 * bills 没有贷项通知单（credit_notes 只挂 invoice_id），所以少一段 credited。
 */
export async function getApAging(
  tx: Tx,
  organizationId: string,
  asOf: string,
): Promise<ApAgingRow[]> {
  const rows = await tx`
    with base as (
      select base_currency from organizations where id = ${organizationId}
    ),
    paid as (
      select
        pi.bill_id as bill_id,
        sum(pi.amount_minor) as paid_minor,
        bool_or(p.currency <> b.currency) as currency_mismatch
      from payment_items pi
      join payments p on p.id = pi.payment_id
      join bills b on b.id = pi.bill_id
      where p.organization_id = ${organizationId}
        and p.voided_at is null
        and p.payment_date <= ${asOf}::date
        and pi.bill_id is not null
      group by pi.bill_id
    ),
    doc as (
      select
        b.contact_id,
        b.due_date,
        b.currency,
        b.total_minor - coalesce(pd.paid_minor, 0) as outstanding_doc,
        (
          (
            b.currency = (select base_currency from base)
            or (t.id is not null and b.total_minor > 0)
          )
          and not coalesce(pd.currency_mismatch, false)
        ) as measurable,
        -- 与应收侧同一个公式，理由见 getArAging 里 outstanding_base 的注释。
        case
          when b.currency = (select base_currency from base)
            then (b.total_minor - coalesce(pd.paid_minor, 0))::bigint
          when t.id is not null and b.total_minor > 0
            then t.base_amount_minor - round(
                   t.base_amount_minor::numeric
                   * least(greatest(coalesce(pd.paid_minor, 0), 0), b.total_minor)::numeric
                   / b.total_minor::numeric
                 )::bigint
          else 0::bigint
        end as outstanding_base
      from bills b
      left join paid pd on pd.bill_id = b.id
      left join transactions t
        on t.id = b.transaction_id
       and t.organization_id = ${organizationId}
       and t.voided_at is null
      where b.organization_id = ${organizationId}
        and b.voided_at is null
        and b.status not in ('draft', 'voided')
        and b.issue_date <= ${asOf}::date
    ),
    agg as (
      select
        d.contact_id,
        c.name as contact_name,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date >= ${asOf}::date
        ), 0) as current,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date < ${asOf}::date
            and d.due_date > ${asOf}::date - interval '30 days'
        ), 0) as d1_30,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date <= ${asOf}::date - interval '30 days'
            and d.due_date > ${asOf}::date - interval '60 days'
        ), 0) as d31_60,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date <= ${asOf}::date - interval '60 days'
            and d.due_date > ${asOf}::date - interval '90 days'
        ), 0) as d61_90,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date <= ${asOf}::date - interval '90 days'
        ), 0) as over90,
        coalesce(sum(d.outstanding_base), 0) as total,
        coalesce(sum(d.outstanding_base) filter (
          where d.due_date < ${asOf}::date
        ), 0) as overdue,
        0::bigint as doc_count,
        array[]::text[] as currencies
      from doc d
      join contacts c on c.id = d.contact_id
      where d.measurable and d.outstanding_doc > 0
      group by d.contact_id, c.name

      union all

      select
        null::uuid, null::text,
        -- 五个桶 + total + overdue = 7 个 0。上面那一支加了 d1_30 之后，
        -- union 两支的列数必须一起改——少一个 Postgres 会直接报列数不符，
        -- 但顺序错了它不会报，只会把 overdue 的值放进 total 那一列。
        0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric,
        count(*)::bigint,
        coalesce(array_agg(distinct d.currency::text), array[]::text[])
      from doc d
      where not d.measurable and d.outstanding_doc > 0
      having count(*) > 0
    )
    select * from agg
    order by (contact_id is null), total desc, contact_name
  `;

  return rows.map(mapAgingRow);
}

/* =========================================================================
   客户 / 供应商对账单
   ========================================================================= */

type StatementEventRow = {
  event_date: Date | string;
  description: string;
  reference: string | null;
  currency: string;
  measurable: boolean;
  base_amount: string;
};

/**
 * 把一串已按日期排好的事件折成对账单。
 *
 * 期初 = 严格早于 from 的净额，期间 = 闭区间 [from, to]，两者互补，
 * 边界那天不会被双算——与 reports.ts 的 openingCash / closingCash 同理。
 */
function foldStatement(rows: readonly StatementEventRow[], from: string, to: string): CustomerStatement {
  let openingBalance = 0n;
  const inPeriod: { date: string; description: string; reference: string; amount: bigint }[] = [];
  let noticeCount = 0;
  const noticeCurrencies = new Set<string>();

  for (const row of rows) {
    const date = formatDateOnly(row.event_date);
    if (date > to) continue;

    if (!row.measurable) {
      noticeCount += 1;
      noticeCurrencies.add(row.currency);
      continue;
    }

    const amount = BigInt(row.base_amount);
    if (date < from) {
      openingBalance += amount;
    } else {
      inPeriod.push({
        date,
        description: row.description,
        reference: row.reference ?? '',
        amount,
      });
    }
  }

  let running = openingBalance;
  const lines: StatementLine[] = inPeriod.map((line) => {
    running += line.amount;
    return { ...line, balance: running };
  });

  return {
    openingBalance,
    lines,
    closingBalance: running,
    notice:
      noticeCount === 0
        ? null
        : { count: noticeCount, currencies: [...noticeCurrencies].sort() },
  };
}

/**
 * 客户对账单。
 *
 * 之前这个函数**跑不起来**：期初余额那条 SQL 是
 * `select coalesce(sum(i.total_minor), 0) ...` 而整条语句里没有
 * `from invoices i`，`i` 是一个未绑定的别名，Postgres 直接报
 * "missing FROM-clause entry for table i"。之所以一直没暴露，是因为全项目
 * 没有任何地方调用它。既然它迟早会被接上，这次一并按账龄表同一套口径重写。
 *
 * 口径：
 *   - 金额一律本位币；换不出本位币的单据不参与任何金额，改为计入 notice；
 *   - 发票 / 收款 / 贷项通知单各自按**自己那张单据**的记账汇率换算。
 *     对账单列的是一件件独立的事件，不是同一张单据的加减，所以逐单换算是
 *     对的，与账龄表「先减后换」并不矛盾：账龄表要的是「一张单据还剩多少」，
 *     对账单要的是「发生过哪些事」。两者的期末余额因此可能差一个汇兑损益，
 *     那个差额正是 fx-gain / fx-loss 两个科目的金额，不是错误。
 *   - 收款按分摊比例换算，见 SQL 里的注释。
 */
export async function getCustomerStatement(
  tx: Tx,
  organizationId: string,
  contactId: string,
  from: string,
  to: string,
): Promise<CustomerStatement> {
  const rows = await tx`
    with base as (
      select base_currency from organizations where id = ${organizationId}
    ),
    ev as (
      select
        i.issue_date as event_date,
        'Invoice' as description,
        i.invoice_number as reference,
        i.currency::text as currency,
        (i.currency = (select base_currency from base) or t.id is not null) as measurable,
        case
          when i.currency = (select base_currency from base) then i.total_minor
          when t.id is not null then t.base_amount_minor
          else 0::bigint
        end as base_amount
      from invoices i
      left join transactions t
        on t.id = i.transaction_id
       and t.organization_id = ${organizationId}
       and t.voided_at is null
      where i.organization_id = ${organizationId}
        and i.contact_id = ${contactId}
        and i.voided_at is null
        and i.status not in ('draft', 'voided')

      union all

      -- 收款按分摊比例换算：payment_items 是一张收款单在多张发票之间的
      -- 分摊，本位币金额必须按同一比例分摊，不能直接拿 p.base_amount_minor
      -- （那是整张收款单的金额，一张收款单核销三张发票时会被重复计入三次）。
      -- nullif 兜住理论上的 amount_minor = 0，避免除零把整张对账单变成 500。
      select
        p.payment_date as event_date,
        'Payment' as description,
        p.reference,
        p.currency::text as currency,
        true as measurable,
        (-round(
          pi.amount_minor::numeric * p.base_amount_minor::numeric
          / nullif(p.amount_minor, 0)::numeric
        ))::bigint as base_amount
      from payment_items pi
      join payments p on p.id = pi.payment_id
      where p.organization_id = ${organizationId}
        and p.contact_id = ${contactId}
        and p.voided_at is null
        and pi.invoice_id is not null

      union all

      select
        cn.issue_date as event_date,
        'Credit Note' as description,
        cn.cn_number as reference,
        cn.currency::text as currency,
        (cn.currency = (select base_currency from base) or t.id is not null) as measurable,
        case
          -- 见 getArAging 里的注释：cn.base_amount_minor 装的是原币总额，
          -- 只有在币种 = 本位币时它才同时也是本位币金额。
          when cn.currency = (select base_currency from base) then -cn.base_amount_minor
          when t.id is not null then -t.base_amount_minor
          else 0::bigint
        end as base_amount
      from credit_notes cn
      left join transactions t
        on t.id = cn.transaction_id
       and t.organization_id = ${organizationId}
       and t.voided_at is null
      where cn.organization_id = ${organizationId}
        and cn.contact_id = ${contactId}
        and cn.voided_at is null
        and cn.status in ('issued', 'applied')
    )
    select event_date, description, reference, currency, measurable, base_amount
    from ev
    order by event_date, description, reference
  `;

  return foldStatement(rows as unknown as StatementEventRow[], from, to);
}

/**
 * 供应商对账单。与 getCustomerStatement 同理，账单为正、付款为负。
 * 原来那条期初 SQL 同样缺 `from bills b`，同样跑不起来。
 */
export async function getVendorStatement(
  tx: Tx,
  organizationId: string,
  contactId: string,
  from: string,
  to: string,
): Promise<CustomerStatement> {
  const rows = await tx`
    with base as (
      select base_currency from organizations where id = ${organizationId}
    ),
    ev as (
      select
        b.issue_date as event_date,
        'Bill' as description,
        b.bill_number as reference,
        b.currency::text as currency,
        (b.currency = (select base_currency from base) or t.id is not null) as measurable,
        case
          when b.currency = (select base_currency from base) then b.total_minor
          when t.id is not null then t.base_amount_minor
          else 0::bigint
        end as base_amount
      from bills b
      left join transactions t
        on t.id = b.transaction_id
       and t.organization_id = ${organizationId}
       and t.voided_at is null
      where b.organization_id = ${organizationId}
        and b.contact_id = ${contactId}
        and b.voided_at is null
        and b.status not in ('draft', 'voided')

      union all

      select
        p.payment_date as event_date,
        'Payment' as description,
        p.reference,
        p.currency::text as currency,
        true as measurable,
        (-round(
          pi.amount_minor::numeric * p.base_amount_minor::numeric
          / nullif(p.amount_minor, 0)::numeric
        ))::bigint as base_amount
      from payment_items pi
      join payments p on p.id = pi.payment_id
      where p.organization_id = ${organizationId}
        and p.contact_id = ${contactId}
        and p.voided_at is null
        and pi.bill_id is not null
    )
    select event_date, description, reference, currency, measurable, base_amount
    from ev
    order by event_date, description, reference
  `;

  return foldStatement(rows as unknown as StatementEventRow[], from, to);
}
