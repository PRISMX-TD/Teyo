'use server';

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

  const found = await withTransaction(context.userId, (tx) =>
    findRate(tx, currency.toUpperCase(), context.baseCurrency, occurredOn),
  );

  if (!found) return { rate: null, source: 'unavailable' };
  return { rate: formatScaledRate(found.scaledRate), source: 'auto' };
}
