import type { Tx } from '@/server/db/transaction';
import { assertLineInvariants, type DraftJournalLine } from '@/server/domain/ledger';
import { RATE_SCALE } from '@/server/domain/exchange-rate';

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

export async function postDepreciation(
  tx: Tx,
  organizationId: string,
  assetId: string,
  period: string,
  opts: {
    userId: string;
    baseCurrency: string;
    insertTransaction: (
      tx: Tx,
      row: {
        organizationId: string;
        kind: 'journal';
        occurredOn: string;
        description: string;
        currency: string;
        amountMinor: bigint;
        baseAmountMinor: bigint;
        scaledRate: bigint;
        rateSource: 'auto';
        categoryId: null;
        createdBy: string;
        clientUuid: string;
      },
    ) => Promise<{ id: string }>;
    // 返回值这里用不上（折旧分录不写审计快照），写成 unknown 而不是 void，
    // 免得 posting 层给写入函数加返回值时这个注入点跟着一起改。
    insertJournalLines: (
      tx: Tx,
      organizationId: string,
      transactionId: string,
      lines: DraftJournalLine[],
    ) => Promise<unknown>;
  },
): Promise<{ transactionId: string }> {
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
  `;
  const schedule = scheduleRows.at(0);
  if (!schedule) throw new Error('No depreciation schedule found for this period.');
  if (schedule.is_posted) throw new Error('This period has already been posted.');

  const depnMinor = BigInt(schedule.depreciation_minor as string);
  if (depnMinor <= 0n) throw new Error('Depreciation amount must be greater than zero.');

  const assetName = asset.name as string;
  const expenseAccountId = asset.depn_expense_account_id as string;
  const accumAccountId = asset.depn_accum_account_id as string;
  const occurredOn = period;

  const clientUuid = crypto.randomUUID();

  const lines: DraftJournalLine[] = [
    { accountId: expenseAccountId, direction: 'debit', amountMinor: depnMinor, baseAmountMinor: depnMinor },
    { accountId: accumAccountId, direction: 'credit', amountMinor: depnMinor, baseAmountMinor: depnMinor },
  ];

  const { id: transactionId } = await opts.insertTransaction(tx, {
    organizationId,
    kind: 'journal',
    occurredOn,
    description: `Depreciation: ${assetName} (${period})`,
    currency: opts.baseCurrency,
    amountMinor: depnMinor,
    baseAmountMinor: depnMinor,
    scaledRate: RATE_SCALE,
    rateSource: 'auto',
    categoryId: null,
    createdBy: opts.userId,
    clientUuid,
  });

  assertLineInvariants(lines, {
    currency: opts.baseCurrency,
    baseCurrency: opts.baseCurrency,
    scaledRate: RATE_SCALE,
    rateSource: 'auto',
  });

  await opts.insertJournalLines(tx, organizationId, transactionId, lines);

  await tx`
    update depreciation_schedules
    set is_posted = true, transaction_id = ${transactionId}
    where id = ${schedule.id}
  `;

  return { transactionId };
}
