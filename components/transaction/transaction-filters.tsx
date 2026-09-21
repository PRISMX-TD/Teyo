'use client';

import { useState } from 'react';
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

  /* 有没有条件正在生效。决定筛选区一进页面是展开还是收起：
     正在筛的时候必须展开——否则用户看到一份被过滤过的列表，却看不见
     是什么在过滤它，只会以为数据丢了。 */
  const FILTER_KEYS = [
    'from', 'to', 'kind', 'category', 'moneyAccount', 'member',
    'minAmount', 'maxAmount', 'keyword', 'includeVoided',
  ] as const;
  const hasActiveFilter = FILTER_KEYS.some((k) => (params.get(k) ?? '') !== '');

  /* 桌面端筛选区一直摊开（一行排得下四五个字段，不值得多点一下）；
     手机上 9 个字段竖着排是 800px 高——打开「流水」看到的整个第一屏
     全是筛选器，一条流水都看不见。

     第一版用的是 <details>，看上去更省事（不用 state、天然可访问），
     但它在这个场景下是错的：桌面端要「永远展开」，而 open 是一个静态
     属性，没法按视口宽度给。想靠 CSS 把浏览器的折叠行为顶回去也不行——
     新版 Chrome 把内容放进 ::details-content 伪元素并对它设
     content-visibility:hidden，在子元素上写 !important 够不着它；实测
     桌面端整块筛选器直接消失了。

     所以改成一个普通按钮 + data 属性：展开与否由 CSS 按视口决定
     （≥768px 无条件显示），JS 只管手机上的那一下。表单字段无论收起
     与否都留在 DOM 里，提交的值不会丢。 */
  const [openOnMobile, setOpenOnMobile] = useState(hasActiveFilter);

  return (
    <div className="filters-disclosure">
      <button
        type="button"
        className="filters-summary"
        aria-expanded={openOnMobile}
        aria-controls="transaction-filters"
        onClick={() => setOpenOnMobile((v) => !v)}
      >
        {t.filters.apply}
        {hasActiveFilter ? <span className="filters-dot" aria-hidden="true" /> : null}
        {hasActiveFilter ? <span className="visually-hidden">{t.filters.activeHint}</span> : null}
      </button>
      <form
        id="transaction-filters"
        action={apply}
        className="filters"
        data-collapsed={openOnMobile ? undefined : 'true'}
      >
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
          <option value="">{t.filters.any}</option>
          <option value="income">{t.transaction.income}</option>
          <option value="expense">{t.transaction.expense}</option>
          <option value="transfer">{t.transaction.transfer}</option>
          <option value="journal">{t.transaction.journal}</option>
        </select>
      </div>

      <div className="filter-field">
        <label htmlFor="categoryId">{t.filters.category}</label>
        <select id="categoryId" name="categoryId" defaultValue={params.get('categoryId') ?? ''}>
          <option value="">{t.filters.any}</option>
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
          <option value="">{t.filters.any}</option>
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
          <option value="">{t.filters.any}</option>
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
    </div>
  );
}
