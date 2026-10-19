'use server';

import { isoDate } from '@/lib/schemas';
import { withTransaction } from '@/server/db/transaction';
import { formatScaledRate } from '@/server/domain/exchange-rate';
import { resolveOrgContext } from '@/server/auth/guard';
import { findRate } from '@/server/repositories/exchange-rates';

/** 表单用它：用户改币种或日期时实时拉汇率。查不到就让用户手填。 */
export async function lookupRate(
  orgSlug: string,
  currency: string,
  occurredOn: string,
): Promise<{ rate: string | null; source: 'auto' | 'unavailable' }> {
  const context = await resolveOrgContext(orgSlug);

  // 表单边输边查，日期框半填（'2026-0'）或币种还没选完时就会打过来。
  // 原来原样交给 SQL，非法日期在 Postgres 那里是一个异常，表单收到的是
  // 报错而不是「查不到，请手填」。形状不对就是查不到。
  if (!/^[A-Za-z]{3}$/.test(currency) || !isoDate.safeParse(occurredOn).success) {
    return { rate: null, source: 'unavailable' };
  }

  const found = await withTransaction(context.userId, (tx) =>
    findRate(tx, currency.toUpperCase(), context.baseCurrency, occurredOn),
  );

  if (!found) return { rate: null, source: 'unavailable' };
  return { rate: formatScaledRate(found.scaledRate), source: 'auto' };
}
