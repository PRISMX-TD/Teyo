import type { Tx } from '@/server/db/transaction';
import { RATE_SCALE } from '@/server/domain/exchange-rate';

export type RateRow = {
  baseCurrency: string;
  quoteCurrency: string;
  scaledRate: bigint;
  rateDate: string;
  source: string;
};

export type RateLookup = { scaledRate: bigint; source: 'auto' } | null;

/** 汇率回溯窗口：周末与假日没有数据，往前找最多 7 天。 */
const LOOKBACK_DAYS = 7;

const RATE_DECIMALS = 8;

/**
 * 表里的列是 rate numeric(20,8)，而应用内部统一用放大 10^8 的 bigint
 * （见 server/domain/exchange-rate.ts）。两者精度相同，转换无损，
 * 但必须走字符串而不是 Number，否则 0.31234567 这类值会被浮点破坏。
 */
function scaledToDecimalString(scaled: bigint): string {
  const digits = scaled.toString().padStart(RATE_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - RATE_DECIMALS);
  const fraction = digits.slice(digits.length - RATE_DECIMALS);
  return `${whole}.${fraction}`;
}

function decimalStringToScaled(value: string): bigint {
  const [whole, fraction = ''] = value.trim().split('.');
  return BigInt(whole + fraction.padEnd(RATE_DECIMALS, '0').slice(0, RATE_DECIMALS));
}

export async function upsertRates(tx: Tx, rows: RateRow[]): Promise<number> {
  if (rows.length === 0) return 0;

  const payload = rows.map((row) => ({
    base_currency: row.baseCurrency,
    quote_currency: row.quoteCurrency,
    rate: scaledToDecimalString(row.scaledRate),
    rate_date: row.rateDate,
    source: row.source,
  }));

  const upserted = await tx`
    insert into exchange_rates ${tx(
      payload,
      'base_currency',
      'quote_currency',
      'rate',
      'rate_date',
      'source',
    )}
    on conflict (base_currency, quote_currency, rate_date)
      do update set rate = excluded.rate,
                    source = excluded.source,
                    fetched_at = now()
    returning id
  `;

  return upserted.length;
}

export async function findRate(
  tx: Tx,
  base: string,
  quote: string,
  onDate: string,
): Promise<RateLookup> {
  if (base === quote) {
    return { scaledRate: RATE_SCALE, source: 'auto' };
  }

  // rate_date <= onDate 是硬性要求：拿晚于交易日的汇率折算，
  // 等于用后来的市场价改写已入账的历史金额。
  const direct = await tx`
    select rate
    from exchange_rates
    where base_currency = ${base}
      and quote_currency = ${quote}
      and rate_date <= ${onDate}::date
      and rate_date >= ${onDate}::date - make_interval(days => ${LOOKBACK_DAYS})
    order by rate_date desc
    limit 1
  `;

  const directRow = direct.at(0);
  if (directRow) {
    return { scaledRate: decimalStringToScaled(String(directRow.rate)), source: 'auto' };
  }

  // 反方向取倒数：只存了 MYR->SGD 时，SGD->MYR 也应可用。
  const inverse = await tx`
    select rate
    from exchange_rates
    where base_currency = ${quote}
      and quote_currency = ${base}
      and rate_date <= ${onDate}::date
      and rate_date >= ${onDate}::date - make_interval(days => ${LOOKBACK_DAYS})
    order by rate_date desc
    limit 1
  `;

  const inverseRow = inverse.at(0);
  if (inverseRow) {
    const stored = decimalStringToScaled(String(inverseRow.rate));
    if (stored > 0n) {
      // RATE_SCALE^2 / stored，四舍五入到最后一位。
      const numerator = RATE_SCALE * RATE_SCALE;
      return { scaledRate: (numerator * 2n + stored) / (stored * 2n), source: 'auto' };
    }
  }

  return null;
}
