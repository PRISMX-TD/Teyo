import type { Tx } from '@/server/db/transaction';

export type DepreciationMethod = 'straight_line' | 'declining_balance';

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
      ${row.purchaseExchangeRate ? row.purchaseExchangeRate.toString() : null}
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

export async function generateDepreciationSchedule(
  tx: Tx,
  organizationId: string,
  assetId: string,
): Promise<DepreciationPeriod[]> {
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

  const periods: DepreciationPeriod[] = [];
  let bookValue = cost;
  let accumulated = 0n;

  for (let i = 0; i < lifeMonths; i++) {
    const remainingMonths = lifeMonths - i;
    let depreciation: bigint;

    if (method === 'straight_line') {
      const depreciable = cost - salvage > 0n ? cost - salvage : 0n;
      const totalSoFar = periods.reduce((sum, p) => sum + p.depreciation, 0n);
      if (i === lifeMonths - 1) {
        depreciation = depreciable - totalSoFar;
      } else {
        depreciation = depreciable / BigInt(lifeMonths);
      }
    } else {
      depreciation = (bookValue * BigInt(decliningRateBps)) / BigInt(10000 * 12);
      const remainingBook = bookValue - depreciation;
      const slPerMonth = remainingMonths <= 1
        ? (bookValue - salvage > 0n ? bookValue - salvage : 0n)
        : (bookValue - salvage) / BigInt(remainingMonths - 1);

      if (slPerMonth > 0n && depreciation < slPerMonth) {
        const depreciable = bookValue - salvage > 0n ? bookValue - salvage : 0n;
        if (i === lifeMonths - 1) {
          depreciation = depreciable;
        } else {
          depreciation = depreciable / BigInt(remainingMonths);
        }
      }

      if (bookValue - depreciation < salvage) {
        depreciation = bookValue - salvage > 0n ? bookValue - salvage : 0n;
      }
    }

    if (depreciation < 0n) depreciation = 0n;

    accumulated = accumulated + depreciation;
    bookValue = bookValue - depreciation;
    if (bookValue < salvage) bookValue = salvage;

    const month = startMonth + i;
    const year = startYear + Math.floor((month - 1) / 12);
    const calendarMonth = ((month - 1) % 12) + 1;
    const period = `${String(year).padStart(4, '0')}-${String(calendarMonth).padStart(2, '0')}-01`;

    periods.push({
      period,
      depreciation,
      accumulated,
      bookValue,
    });
  }

  if (periods.length > 0) {
    await tx`
      insert into depreciation_schedules ${tx(
        periods.map((p) => ({
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
        book_value_minor = excluded.book_value_minor,
        is_posted = false
    `;
  }

  return periods;
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
 */
export async function markDepreciationPosted(
  tx: Tx,
  organizationId: string,
  scheduleId: string,
  transactionId: string,
): Promise<void> {
  await tx`
    update depreciation_schedules
    set is_posted = true, transaction_id = ${transactionId}
    where id = ${scheduleId}
      and fixed_asset_id in (
        select id from fixed_assets where organization_id = ${organizationId}
      )
  `;
}
