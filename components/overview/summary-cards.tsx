import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { AccountBalance, CategoryShare, MonthTotals } from '@/server/repositories/overview';

type NamePair = { nameEn: string | null; nameZh: string | null };

/** 仓库层用 camelCase，localizedName 要 snake_case，这里桥接一下。 */
function toNamePair(row: NamePair): { name_en: string | null; name_zh: string | null } {
  return { name_en: row.nameEn, name_zh: row.nameZh };
}

type Props = {
  totals: MonthTotals;
  balances: AccountBalance[];
  shares: CategoryShare[];
  baseCurrency: string;
  locale: Locale;
};

export function SummaryCards({ totals, balances, shares, baseCurrency, locale }: Props) {
  const t = getMessages(locale);
  const totalExpense = shares.reduce((sum, share) => sum + share.totalMinor, 0n);

  return (
    <section className="overview-grid">
      <article className="card">
        <h2>{t.overview.monthIncome}</h2>
        <p className="figure money-in">{formatMoney(totals.incomeMinor, baseCurrency, locale)}</p>
      </article>

      <article className="card">
        <h2>{t.overview.monthExpense}</h2>
        <p className="figure money-out">{formatMoney(totals.expenseMinor, baseCurrency, locale)}</p>
      </article>

      <article className="card">
        <h2>{t.overview.monthNet}</h2>
        <p className="figure">{formatMoney(totals.netMinor, baseCurrency, locale)}</p>
      </article>

      <article className="card">
        <h2>{t.overview.accountBalances}</h2>
        <ul>
          {balances.map((balance) => (
            <li key={balance.accountId}>
              <span>{localizedName(toNamePair(balance), locale)}</span>
              <span>{formatMoney(balance.balanceMinor, baseCurrency, locale)}</span>
            </li>
          ))}
        </ul>
      </article>

      <article className="card">
        <h2>{t.overview.spendingByCategory}</h2>
        {shares.length === 0 ? (
          <p>{t.overview.empty}</p>
        ) : (
          <ul>
            {shares.map((share) => {
              const percent =
                totalExpense > 0n ? Number((share.totalMinor * 100n) / totalExpense) : 0;
              return (
                <li key={share.categoryId}>
                  <span>{localizedName(toNamePair(share), locale)}</span>
                  <span
                    className="share-bar"
                    style={{ inlineSize: `${percent}%` }}
                    aria-hidden="true"
                  />
                  <span>{formatMoney(share.totalMinor, baseCurrency, locale)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </article>
    </section>
  );
}
