'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';

type Option = { id: string; name_en: string | null; name_zh: string | null };

type Props = {
  orgSlug: string;
  locale: Locale;
  categories: Option[];
  moneyAccounts: Option[];
  members: Array<{ userId: string; displayName: string }>;
};

export function TransactionFilters({ orgSlug, locale, categories, moneyAccounts, members }: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const params = useSearchParams();

  function apply(formData: FormData) {
    const next = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
      const text = String(value).trim();
      if (text.length > 0) next.set(key, text);
    }
    router.push(`/${orgSlug}/transactions?${next.toString()}`);
  }

  return (
    <form action={apply} className="filters">
      <div className="filter-field">
        <label htmlFor="from">{t.filters.from}</label>
        <input id="from" name="from" type="date" defaultValue={params.get('from') ?? ''} />
      </div>

      <div className="filter-field">
        <label htmlFor="to">{t.filters.to}</label>
        <input id="to" name="to" type="date" defaultValue={params.get('to') ?? ''} />
      </div>

      <div className="filter-field">
        <label htmlFor="kind">{t.filters.kind}</label>
        <select id="kind" name="kind" defaultValue={params.get('kind') ?? ''}>
          <option value="">—</option>
          <option value="income">{t.transaction.income}</option>
          <option value="expense">{t.transaction.expense}</option>
          <option value="transfer">{t.transaction.transfer}</option>
          <option value="journal">{t.transaction.journal}</option>
        </select>
      </div>

      <div className="filter-field">
        <label htmlFor="categoryId">{t.filters.category}</label>
        <select id="categoryId" name="categoryId" defaultValue={params.get('categoryId') ?? ''}>
          <option value="">—</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {localizedName(c, locale)}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-field">
        <label htmlFor="moneyAccountId">{t.filters.moneyAccount}</label>
        <select id="moneyAccountId" name="moneyAccountId" defaultValue={params.get('moneyAccountId') ?? ''}>
          <option value="">—</option>
          {moneyAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {localizedName(a, locale)}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-field">
        <label htmlFor="createdBy">{t.filters.member}</label>
        <select id="createdBy" name="createdBy" defaultValue={params.get('createdBy') ?? ''}>
          <option value="">—</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-field">
        <label htmlFor="minAmount">{t.filters.minAmount}</label>
        <input id="minAmount" name="minAmount" inputMode="decimal" defaultValue={params.get('minAmount') ?? ''} />
      </div>

      <div className="filter-field">
        <label htmlFor="maxAmount">{t.filters.maxAmount}</label>
        <input id="maxAmount" name="maxAmount" inputMode="decimal" defaultValue={params.get('maxAmount') ?? ''} />
      </div>

      <div className="filter-field">
        <label htmlFor="keyword">{t.filters.keyword}</label>
        <input id="keyword" name="keyword" defaultValue={params.get('keyword') ?? ''} />
      </div>

      <div className="filter-actions">
        <label htmlFor="includeVoided" className="filter-toggle">
          <input id="includeVoided" name="includeVoided" type="checkbox" value="true"
            defaultChecked={params.get('includeVoided') === 'true'} />
          {t.filters.includeVoided}
        </label>

        <button type="submit">{t.filters.apply}</button>
        <button type="button" onClick={() => router.push(`/${orgSlug}/transactions`)}>
          {t.filters.reset}
        </button>
      </div>
    </form>
  );
}
