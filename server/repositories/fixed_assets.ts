import type { Tx } from '@/server/db/transaction';
import { formatScaledRate } from '@/server/domain/exchange-rate';

export type DepreciationMethod = 'straight_line' | 'declining_balance';

/**
 * 关于多币种：0011 迁移给 fixed_assets 加了 original_currency /
 * original_cost_minor / purchase_exchange_rate 三列，而折旧自始至终只用
 * cost_minor（本位币）。**这是有意的，也是对的**，不是「忘了接进去」。
 *
 * 固定资产是非货币性项目：按购入日的汇率折算一次，之后不再按新汇率重估。
 * createFixedAsset 里那次 convertToBaseMinor 就是那唯一一次折算，落进
 * cost_minor；排程、每一期分录、资产负债表上的账面净值全部照它走。
 *
 * 如果反过来做——每期折旧时按当期汇率重算原值——会发生的事是：汇率一动，
 * 这台资产的历史成本就跟着动，累计折旧与账面原值分属两个不同的汇率口径，
 * 资产负债表上的净值再也无法由「原值 - 累计折旧」还原。而汇率变动产生的
 * 损益本来就不该出现在一台机器上，它属于汇兑损益（fx-gain / fx-loss，
 * 0021 迁移新加），只对货币性项目（应收、应付、外币存款）成立。
 *
 * 所以那三列确实只是留痕：它们回答「当初花了多少日元、按什么汇率记的账」，
 * 不参与任何计算。今天没有页面读它们，这一段注释是它们存在的理由。
 */

export type FixedAssetRow = {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  purchaseDate: string;
  costMinor: bigint;
  salvageValueMinor: bigint;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  decliningRateBps: number | null;
  assetAccountId: string;
  depnExpenseAccountId: string;
  depnAccumAccountId: string;
  isActive: boolean;
  disposedAt: string | null;
  createdAt: string;
  /** 以下三个字段仅作购入时的换算留痕，不参与折旧计算。 */
  originalCurrency: string | null;
  originalCostMinor: bigint | null;
  purchaseExchangeRate: string | null;
};

export type FixedAssetDetail = FixedAssetRow & {
  assetAccountName: string;
  depnExpenseAccountName: string;
  depnAccumAccountName: string;
};

export type DepreciationScheduleRow = {
  id: string;
  fixedAssetId: string;
  period: string;
  depreciationMinor: bigint;
  accumulatedMinor: bigint;
  bookValueMinor: bigint;
  isPosted: boolean;
  transactionId: string | null;
};

export type DepreciationPeriod = {
  period: string;
  depreciation: bigint;
  accumulated: bigint;
  bookValue: bigint;
};

function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mapAsset(row: Record<string, unknown>): FixedAssetDetail {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    purchaseDate: formatDateOnly(row.purchase_date as Date | string),
    costMinor: BigInt(row.cost_minor as string),
    salvageValueMinor: BigInt(row.salvage_value_minor as string),
    usefulLifeMonths: Number(row.useful_life_months),
    method: row.method as DepreciationMethod,
    decliningRateBps: row.declining_rate_bps ? Number(row.declining_rate_bps) : null,
    assetAccountId: row.asset_account_id as string,
    depnExpenseAccountId: row.depn_expense_account_id as string,
    depnAccumAccountId: row.depn_accum_account_id as string,
    isActive: row.is_active as boolean,
    disposedAt: row.disposed_at ? (row.disposed_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    originalCurrency: (row.original_currency as string | null) ?? null,
    originalCostMinor:
      row.original_cost_minor == null ? null : BigInt(row.original_cost_minor as string),
    purchaseExchangeRate:
      row.purchase_exchange_rate == null ? null : String(row.purchase_exchange_rate),
    assetAccountName: row.asset_account_name as string,
    depnExpenseAccountName: row.depn_expense_account_name as string,
    depnAccumAccountName: row.depn_accum_account_name as string,
  };
}

export async function listFixedAssets(
  tx: Tx,
  organizationId: string,
): Promise<FixedAssetDetail[]> {
  const rows = await tx`
    select
      fa.id, fa.organization_id, fa.name, fa.description,
      fa.purchase_date, fa.cost_minor, fa.salvage_value_minor,
      fa.useful_life_months, fa.method, fa.declining_rate_bps,
      fa.asset_account_id, fa.depn_expense_account_id, fa.depn_accum_account_id,
      fa.is_active, fa.disposed_at, fa.created_at,
      fa.original_currency, fa.original_cost_minor, fa.purchase_exchange_rate,
      aa.name_en as asset_account_name,
      dea.name_en as depn_expense_account_name,
      daa.name_en as depn_accum_account_name
    from fixed_assets fa
    join accounts aa on aa.id = fa.asset_account_id
    join accounts dea on dea.id = fa.depn_expense_account_id
    join accounts daa on daa.id = fa.depn_accum_account_id
    where fa.organization_id = ${organizationId}
    order by fa.created_at desc
  `;
  return rows.map(mapAsset);
}

export async function getFixedAsset(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<FixedAssetDetail | null> {
  const rows = await tx`
    select
      fa.id, fa.organization_id, fa.name, fa.description,
      fa.purchase_date, fa.cost_minor, fa.salvage_value_minor,
      fa.useful_life_months, fa.method, fa.declining_rate_bps,
      fa.asset_account_id, fa.depn_expense_account_id, fa.depn_accum_account_id,
      fa.is_active, fa.disposed_at, fa.created_at,
      fa.original_currency, fa.original_cost_minor, fa.purchase_exchange_rate,
      aa.name_en as asset_account_name,
      dea.name_en as depn_expense_account_name,
      daa.name_en as depn_accum_account_name
    from fixed_assets fa
    join accounts aa on aa.id = fa.asset_account_id
    join accounts dea on dea.id = fa.depn_expense_account_id
    join accounts daa on daa.id = fa.depn_accum_account_id
    where fa.id = ${id} and fa.organization_id = ${organizationId}
  `;
  const row = rows.at(0);
  return row ? mapAsset(row) : null;
}

/**
 * purchase_exchange_rate 是 numeric(20,8)，而应用内部用放大 10^8 的 bigint。
 * 这里原样 toString() 会把 0.031 写成 3100000——留痕栏记下的汇率大一亿倍，
 * 而它只作留痕、今天没有任何页面读它，所以谁也不会发现。与 insertTransaction
 * 写 exchange_rate 那一列同样走 formatScaledRate，全程不经 Number。
 */
export async function insertFixedAsset(
  tx: Tx,
  row: {
    organizationId: string;
    name: string;
    description: string | null;
    purchaseDate: string;
    costMinor: bigint;
    salvageValueMinor: bigint;
    usefulLifeMonths: number;
    method: DepreciationMethod;
    decliningRateBps: number | null;
    assetAccountId: string;
    depnExpenseAccountId: string;
    depnAccumAccountId: string;
    originalCurrency?: string | null;
    originalCostMinor?: bigint | null;
    purchaseExchangeRate?: bigint | null;
  },
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into fixed_assets (
      organization_id, name, description,
      purchase_date, cost_minor, salvage_value_minor,
      useful_life_months, method, declining_rate_bps,
      asset_account_id, depn_expense_account_id, depn_accum_account_id,
      original_currency, original_cost_minor, purchase_exchange_rate
    )
    values (
      ${row.organizationId},
      ${row.name},
      ${row.description},
      ${row.purchaseDate},
      ${row.costMinor.toString()},
      ${row.salvageValueMinor.toString()},
      ${row.usefulLifeMonths},
      ${row.method}::depreciation_method,
      ${row.decliningRateBps},
      ${row.assetAccountId},
      ${row.depnExpenseAccountId},
      ${row.depnAccumAccountId},
      ${row.originalCurrency ?? null},
      ${row.originalCostMinor ? row.originalCostMinor.toString() : null},
      ${row.purchaseExchangeRate ? formatScaledRate(row.purchaseExchangeRate) : null}
    )
    returning id
  `;
  return { id: inserted[0].id as string };
}

export async function updateFixedAsset(
  tx: Tx,
  organizationId: string,
  id: string,
  fields: {
    name?: string;
    description?: string | null;
    purchaseDate?: string;
    costMinor?: bigint;
    salvageValueMinor?: bigint;
    usefulLifeMonths?: number;
    method?: DepreciationMethod;
    decliningRateBps?: number | null;
    assetAccountId?: string;
    depnExpenseAccountId?: string;
    depnAccumAccountId?: string;
  },
): Promise<void> {
  const sets: Record<string, unknown> = {};
  if (fields.name !== undefined) sets.name = fields.name;
  if (fields.description !== undefined) sets.description = fields.description;
  if (fields.purchaseDate !== undefined) sets.purchase_date = fields.purchaseDate;
  if (fields.costMinor !== undefined) sets.cost_minor = fields.costMinor.toString();
  if (fields.salvageValueMinor !== undefined) sets.salvage_value_minor = fields.salvageValueMinor.toString();
  if (fields.usefulLifeMonths !== undefined) sets.useful_life_months = fields.usefulLifeMonths;
  if (fields.method !== undefined) sets.method = fields.method;
  if (fields.decliningRateBps !== undefined) sets.declining_rate_bps = fields.decliningRateBps;
  if (fields.assetAccountId !== undefined) sets.asset_account_id = fields.assetAccountId;
  if (fields.depnExpenseAccountId !== undefined) sets.depn_expense_account_id = fields.depnExpenseAccountId;
  if (fields.depnAccumAccountId !== undefined) sets.depn_accum_account_id = fields.depnAccumAccountId;

  const keys = Object.keys(sets);
  if (keys.length === 0) return;

  await tx`
    update fixed_assets set ${tx(sets as Record<string, never>)}
    where id = ${id} and organization_id = ${organizationId}
  `;
}

export async function disposeFixedAsset(
  tx: Tx,
  organizationId: string,
  id: string,
): Promise<void> {
  await tx`
    update fixed_assets
    set disposed_at = now(), is_active = false
    where id = ${id} and organization_id = ${organizationId}
  `;
}

/** 重算一次排程的结果。 */
export type ScheduleRegeneration = {
  /** 重算之后这条资产完整的排程，含被冻结的已过账期间。 */
  periods: DepreciationPeriod[];
  /** 已过账、因而一个字节都没改的期间（YYYY-MM-DD，升序）。 */
  keptPostedPeriods: string[];
};

/**
 * 从购入日起数第 i 个月的期间键（每期固定落在当月 1 号）。
 */
function periodKey(startYear: number, startMonth: number, offset: number): string {
  const month = startMonth + offset;
  const year = startYear + Math.floor((month - 1) / 12);
  const calendarMonth = ((month - 1) % 12) + 1;
  return `${String(year).padStart(4, '0')}-${String(calendarMonth).padStart(2, '0')}-01`;
}

/**
 * 重算折旧排程。**已过账的期间一个字节都不改。**
 *
 * 这个函数原来是本项目里最危险的一处写入。它的 upsert 写的是
 * `do update set depreciation_minor = ..., is_posted = false`，而
 * updateFixedAssetAction 在 cost / salvage / life / method / purchaseDate
 * 任一变动时都会重新调用它。于是：一期折旧过账之后，用户去改一下账面原值，
 * 那一期的 is_posted 被重置回 false、金额被覆盖，而 transaction_id 原样留着
 * ——分录还在账上。随后 loadDepreciationPosting 里的 `if (schedule.is_posted)`
 * 顺利通过，同一期折旧记第二笔。两笔各自一借一贷，配平触发器、assertBalanced、
 * 行级不变量、账户归属校验四道校验没有任何一道会发现：它们核对的是「这一笔
 * 内部自洽吗」，没有任何一道知道「这一期是不是已经记过了」。
 *
 * 选的是三种方案里的第一种——重算时跳过已过账期间，把改动只落在之后的期间上：
 *
 *   (a) 跳过已过账期间，剩余期间按剩余账面净值重摊。← 本函数
 *   (b) 要求先对已过账期间生成反向分录冲销，再重算。
 *   (c) 直接拒绝修改已开始折旧的资产的关键参数。
 *
 * 选 (a) 的理由有三条，都不是「实现起来最省事」：
 *
 * 1. 它就是会计上对「会计估计变更」的标准处理：已入账的历史不因为参数修正
 *    而改写，变更自变更日起未来适用（prospective）。把一台机器的年限从 5 年
 *    改成 4 年，不意味着过去两年的折旧记错了。
 * 2. (b) 要求用户理解「冲销」，并且会在账上留下一对互相抵消的分录；真正需要
 *    冲销的是「当初录错了原值」那一种，而那种情况用户应该作废资产重建，不是
 *    改参数。把冲销塞进「改一下数字」这个动作里，代价是每个改过参数的用户
 *    都会在总账里多出两笔他没打算记的分录。
 * 3. (c) 会让资产一旦过了第一期就再也改不了名字以外的任何东西——而
 *    updateFixedAssetAction 的 needsRegen 判断把 cost / salvage / life /
 *    method / rate / purchaseDate 全列进去了，等于把整张编辑表单锁死。
 *
 * 「剩余期间按剩余账面净值重摊」不是可选项而是 (a) 的必要组成部分。若只是
 * 跳过已过账期间、剩下的照新参数从头算，全生命周期的折旧合计就不再等于
 * 成本减残值：1200 摊 4 期、过了 2 期（各 300）之后把原值改成 2400，剩下
 * 两期若各记 600，合计 300+300+600+600 = 1800，这台资产永远折不完，而
 * 账面上处处配平。按剩余净值重摊则是 (2400-600)/2 = 900，合计正好 2400。
 *
 * 两道防线，不是一道：
 *   - 应用侧：已过账期间原样取用库里那个数参与滚动计算，不进 upsert 的值列表；
 *   - 数据库侧：upsert 的 DO UPDATE 带 `where is_posted = false`。这一条防的是
 *     「读出已过账集合」与「写回」之间的并发窗口——READ COMMITTED 下另一个
 *     标签页可以在这中间把某一期过账掉。ON CONFLICT DO UPDATE 会对冲突行加锁
 *     并按提交后的最新版本求值 WHERE，所以那一期会被静默跳过而不是被覆盖。
 *     少了这一条，第一道防线读到的就是一份过期的快照。
 *
 * 同时修掉的第二个静默缺陷：缩短年限。原来的写法只 upsert 新算出来的那些期间，
 * 从不删除任何行。把 24 个月改成 12 个月之后，13-24 期仍然躺在表里、is_posted
 * 仍然是 false，排程页照样把它们列出来，用户照样点得动「过账」——一台早已折完
 * 的资产可以继续折下去。这里补上一句删除，但只删未过账的：已过账的期间即使
 * 落在新年限之外也必须留着，它对应的分录在账上。
 */
export async function generateDepreciationSchedule(
  tx: Tx,
  organizationId: string,
  assetId: string,
): Promise<ScheduleRegeneration> {
  const assetRows = await tx`
    select cost_minor, salvage_value_minor, useful_life_months, method, declining_rate_bps, purchase_date
    from fixed_assets
    where id = ${assetId} and organization_id = ${organizationId}
  `;
  const asset = assetRows.at(0);
  if (!asset) throw new Error('Fixed asset not found.');

  const cost = BigInt(asset.cost_minor as string);
  const salvage = BigInt(asset.salvage_value_minor as string);
  const lifeMonths = Number(asset.useful_life_months);
  const method = asset.method as DepreciationMethod;
  const decliningRateBps = asset.declining_rate_bps ? Number(asset.declining_rate_bps) : 20000;

  const purchaseDate = formatDateOnly(asset.purchase_date as Date | string);
  const [yearStr, monthStr] = purchaseDate.split('-');
  const startYear = Number(yearStr);
  const startMonth = Number(monthStr);

  // 已过账的期间及其金额。取的是库里那个数，不是重算出来的数——「已入账的
  // 历史不改写」这句话必须落在参与滚动计算的那个值上，否则后面几期的起点
  // 就是一个从未真正入过账的账面净值。
  const postedRows = await tx`
    select period, depreciation_minor
    from depreciation_schedules
    where fixed_asset_id = ${assetId} and is_posted = true
  `;
  const postedByPeriod = new Map<string, bigint>(
    postedRows.map((row) => [
      formatDateOnly(row.period as Date | string),
      BigInt(row.depreciation_minor as string),
    ]),
  );

  const periodKeys: string[] = [];
  for (let i = 0; i < lifeMonths; i++) {
    periodKeys.push(periodKey(startYear, startMonth, i));
  }

  // 滚动计算要覆盖的是「新排程的期间」并上「已过账的期间」，不只是前者。
  //
  // 改购入日或缩短年限会让某些已过账的期间整个掉出新的期间列表。只按新列表
  // 算的话，那几期入账过的折旧就不在 accumulated 里了，剩余期间会从完整的
  // 原值重新摊起——已经记过的折旧被记第二遍，只是换了个期间名字。并上去之后
  // 它们照样冻结、照样参与滚动，掉出范围的只是「不再有新的未过账行」。
  // 'YYYY-MM-DD' 按字典序排就是按时间序排。
  const allPeriods = [...new Set([...periodKeys, ...postedByPeriod.keys()])].sort();

  // unpostedAhead[i] = 含本期在内、从第 i 期起还剩几期没过账。
  // 直线法与余额递减法切换判断都按「还剩几期要摊」来分母，而不是「还剩几个月」
  // ——已过账的那几期不再参与摊销，把它们数进分母会让剩下的每一期都摊少，
  // 最后一期再一次性补齐，形成一个谁也解释不了的尾巴。
  const unpostedAhead = new Array<number>(allPeriods.length).fill(0);
  let ahead = 0;
  for (let i = allPeriods.length - 1; i >= 0; i--) {
    if (!postedByPeriod.has(allPeriods[i])) ahead += 1;
    unpostedAhead[i] = ahead;
  }

  const periods: DepreciationPeriod[] = [];
  let bookValue = cost;
  let accumulated = 0n;

  for (let i = 0; i < allPeriods.length; i++) {
    const period = allPeriods[i];
    const posted = postedByPeriod.get(period);
    let depreciation: bigint;

    if (posted !== undefined) {
      // 已过账：原样取用，不重算。
      depreciation = posted;
    } else {
      // 两种方法都从「当前账面净值」出发，而不是从原值出发。这正是 (a) 方案
      // 成立的地方：前面几期无论是按什么参数入账的，剩下要摊的就是此刻还剩
      // 的这些钱。n 是含本期在内还剩几期要摊；n === 1 时把剩余全部摊完，
      // 整条排程的合计因此恒等于 cost - salvage，不需要在最后一期另写一句
      // 「补差额」。
      const n = unpostedAhead[i];
      const depreciable = bookValue > salvage ? bookValue - salvage : 0n;
      const straightLine = n <= 1 ? depreciable : depreciable / BigInt(n);

      if (method === 'straight_line') {
        depreciation = straightLine;
      } else {
        // 余额递减法：年率 decliningRateBps 摊到每个月。
        depreciation = (bookValue * BigInt(decliningRateBps)) / BigInt(10000 * 12);

        // 教科书上的「切换到直线法」：递减额一旦低于按剩余期数算的直线额，
        // 之后各期改用直线额，否则残值永远摊不到。
        //
        // 原来这里的分母是 remainingMonths - 1 而不是 remainingMonths，于是
        // 直线额被算大一期份，切换点整整提前一期，倒数第二期会把几乎全部
        // 剩余净值一次摊光。折旧总额仍然等于成本减残值，每一期仍然配平——
        // 错的只是分布，这正是没有任何一道校验看得见的那类错误。
        if (depreciation < straightLine) depreciation = straightLine;

        // 不能跌破残值。
        if (depreciation > depreciable) depreciation = depreciable;
      }
    }

    if (depreciation < 0n) depreciation = 0n;

    accumulated = accumulated + depreciation;
    bookValue = bookValue - depreciation;
    if (bookValue < salvage) bookValue = salvage;

    periods.push({ period, depreciation, accumulated, bookValue });
  }

  // 只写未过账的那些期间。已过账的期间连同它的 accumulated/book_value 一起
  // 保持原样：那两个数是它入账当时的口径，改写它们等于事后修订一份已经发出去
  // 的报表。
  const writable = periods.filter((p) => !postedByPeriod.has(p.period));

  if (writable.length > 0) {
    await tx`
      insert into depreciation_schedules ${tx(
        writable.map((p) => ({
          fixed_asset_id: assetId,
          period: p.period,
          depreciation_minor: p.depreciation.toString(),
          accumulated_minor: p.accumulated.toString(),
          book_value_minor: p.bookValue.toString(),
          is_posted: false,
        })),
        'fixed_asset_id',
        'period',
        'depreciation_minor',
        'accumulated_minor',
        'book_value_minor',
        'is_posted',
      )}
      on conflict (fixed_asset_id, period)
      do update set
        depreciation_minor = excluded.depreciation_minor,
        accumulated_minor = excluded.accumulated_minor,
        book_value_minor = excluded.book_value_minor
      where depreciation_schedules.is_posted = false
    `;
  }

  // 年限缩短（或购入日前移）之后落在新排程之外、且还没过账的期间要作废掉，
  // 否则它们仍然躺在表里、is_posted 仍然是 false、排程页照样列出来，用户照样
  // 点得动「过账」——一台早已折完的资产可以继续折下去。原来的写法只 upsert
  // 新算出来的那些期间，从不处理多出来的那些。
  //
  // 作废的方式是把金额清零，不是 delete。两个理由：
  //   1. loadDepreciationPosting 的第四条校验是「金额必须为正」，清零之后这些
  //      行就过不了账了，而这正是要达到的效果——不需要它们消失，只需要它们
  //      不再是一条可以入账的排程。
  //   2. depreciation_schedules 在 RLS 上不打算有 delete 策略（软删除是这批表
  //      的统一做法，见 server/domain/permissions.ts 的 TABLE_ACCESS）。没有
  //      delete 策略时，一条 DELETE 不会报错，只会匹配零行——静默无效正是
  //      本次要根除的那类故障。UPDATE 策略是有的，且与本 action 要求的
  //      account:manage 同为 owner/admin，锁得住也写得进。
  await tx`
    update depreciation_schedules
    set depreciation_minor = 0, accumulated_minor = 0, book_value_minor = 0
    where fixed_asset_id = ${assetId}
      and is_posted = false
      and period <> all(${periodKeys}::date[])
  `;

  return {
    periods,
    keptPostedPeriods: [...postedByPeriod.keys()].sort(),
  };
}

export async function getDepreciationSchedules(
  tx: Tx,
  organizationId: string,
  assetId: string,
): Promise<DepreciationScheduleRow[]> {
  const asset = await tx`
    select id from fixed_assets
    where id = ${assetId} and organization_id = ${organizationId}
  `;
  if (asset.length === 0) return [];

  const rows = await tx`
    select id, fixed_asset_id, period, depreciation_minor,
           accumulated_minor, book_value_minor, is_posted, transaction_id
    from depreciation_schedules
    where fixed_asset_id = ${assetId}
    order by period
  `;

  return rows.map((row) => ({
    id: row.id as string,
    fixedAssetId: row.fixed_asset_id as string,
    period: formatDateOnly(row.period as Date | string),
    depreciationMinor: BigInt(row.depreciation_minor as string),
    accumulatedMinor: BigInt(row.accumulated_minor as string),
    bookValueMinor: BigInt(row.book_value_minor as string),
    isPosted: row.is_posted as boolean,
    transactionId: (row.transaction_id as string | null) ?? null,
  }));
}

/** 过一期折旧所需的全部内容，读自库并已校验完毕。 */
export type PendingDepreciation = {
  /** 过账成功后要标记的那一行排程。 */
  scheduleId: string;
  assetName: string;
  depnExpenseAccountId: string;
  depnAccumAccountId: string;
  depreciationMinor: bigint;
};

/**
 * 读出并校验某一期折旧，分录由调用方交给 postJournal 去写。
 *
 * 这里原本是 postDepreciation：靠一个 opts 把 insertTransaction /
 * insertJournalLines 注进来，仓储层自己写记账凭证。那个注入点存在的唯一
 * 理由是绕开分层，代价是这条路径同时绕开了期间锁检查与审计快照——两者
 * 都在 postJournal 里，而它从来没走过 postJournal。注入删掉之后，仓储只
 * 做它本来该做的事：读自己那两张表、把四条校验跑完，一行分录也不写。
 *
 * 四条校验一条不少、文案逐字不变：资产在不在本公司、这一期有没有排程、
 * 是不是已经过账、金额是不是正数。
 *
 * for update 是这里唯一新增的东西。is_posted 才是这条路径真正的幂等键：
 * clientUuid 每次都新随机一个，postJournal 自己那道幂等查询永远命中不了。
 * 而 READ COMMITTED 下，两次同时点「过账」（两个标签页就够）会各自读到
 * is_posted = false，各自过一笔，同一期折旧记两遍——与任务 5 给定期规则
 * 修掉的是同一个缺陷。加上行锁后，第二次会停在锁上，等第一次提交，
 * Postgres 用 EvalPlanQual 取这一行的最新版本重跑，读到的 is_posted 已经
 * 是 true，下面那句检查随即抛错，第二次一个字节都不写。锁一直持有到调用方
 * 那个 withTransaction 提交为止，所以「读到 false」与「写成 true」之间不
 * 存在任何窗口。
 *
 * 锁只要 RLS 的 using 子句（成员即可），而随后 markDepreciationPosted 那句
 * UPDATE 要的是 with check（owner/admin）——调用方的 account:manage 本就
 * 只有 owner 与 admin 有，两者对得上，不会出现「锁得住却写不进」。
 */
export async function loadDepreciationPosting(
  tx: Tx,
  organizationId: string,
  assetId: string,
  period: string,
): Promise<PendingDepreciation> {
  const assetRows = await tx`
    select name, depn_expense_account_id, depn_accum_account_id
    from fixed_assets
    where id = ${assetId} and organization_id = ${organizationId}
  `;
  const asset = assetRows.at(0);
  if (!asset) throw new Error('Fixed asset not found.');

  const scheduleRows = await tx`
    select id, depreciation_minor, is_posted
    from depreciation_schedules
    where fixed_asset_id = ${assetId} and period = ${period}::date
    for update
  `;
  const schedule = scheduleRows.at(0);
  if (!schedule) throw new Error('No depreciation schedule found for this period.');
  if (schedule.is_posted) throw new Error('This period has already been posted.');

  const depnMinor = BigInt(schedule.depreciation_minor as string);
  if (depnMinor <= 0n) throw new Error('Depreciation amount must be greater than zero.');

  return {
    scheduleId: schedule.id as string,
    assetName: asset.name as string,
    depnExpenseAccountId: asset.depn_expense_account_id as string,
    depnAccumAccountId: asset.depn_accum_account_id as string,
    depreciationMinor: depnMinor,
  };
}

/**
 * 把一期排程标成已过账，并记下那笔交易的 id。
 *
 * 与 loadDepreciationPosting 分成两半，正是因为夹在中间的那一步——写分录
 * ——已经不归仓储管了：postJournal 是记账凭证的唯一出口。
 *
 * where 子句里带上公司：id 本身来自上面那次已经按公司过滤过的查询，多这
 * 一层不是为了当下，而是为了这个函数日后被别处调用时，仍然是它自己在保证
 * 只改本公司的行，而不是依赖某个调用方先查对了。
 *
 * 但多一个 where 条件就多一种「一行都没匹配上」的可能，而 UPDATE 匹配零行
 * 不会报错——从调用方看来，没改动和改成功长得一模一样。走到这一步时
 * postJournal 已经把分录写完了，于是静默的空更新留下的是：交易在账上、
 * 排程仍是 is_posted = false。用户看不出异常，再点一次「过账」就又是一笔，
 * 两笔各自配平，谁也发现不了。所以这里必须 fail closed：数一下真正改了几行，
 * 不是恰好一行就抛错，让整个事务连同那笔分录一起回滚。
 */
export async function markDepreciationPosted(
  tx: Tx,
  organizationId: string,
  scheduleId: string,
  transactionId: string,
): Promise<void> {
  const updated = await tx`
    update depreciation_schedules
    set is_posted = true, transaction_id = ${transactionId}
    where id = ${scheduleId}
      and fixed_asset_id in (
        select id from fixed_assets where organization_id = ${organizationId}
      )
    returning id
  `;

  if (updated.length !== 1) {
    throw new Error(
      `Could not mark depreciation schedule ${scheduleId} as posted (${updated.length} rows matched).`,
    );
  }
}
