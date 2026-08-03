'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { RateField } from '@/components/transaction/rate-field';
import { createTransaction } from '@/server/actions/transactions';

type Option = { id: string; name_en: string | null; name_zh: string | null };

type Props = {
  orgSlug: string;
  baseCurrency: string;
  locale: Locale;
  moneyAccounts: Option[];
  incomeCategories: Option[];
  expenseCategories: Option[];
  currencies: string[];
};

const KINDS = ['expense', 'income', 'transfer'] as const;
type Kind = (typeof KINDS)[number];

export function TransactionForm({
  orgSlug,
  baseCurrency,
  locale,
  moneyAccounts,
  incomeCategories,
  expenseCategories,
  currencies,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const [kind, setKind] = useState<Kind>('expense');
  const [currency, setCurrency] = useState(baseCurrency);
  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // 幂等键在表单整个生命周期内固定，重复提交不会产生重复账目
  const clientUuid = useMemo(() => crypto.randomUUID(), []);

  const categories = kind === 'income' ? incomeCategories : expenseCategories;
  const kindLabels: Record<Kind, string> = {
    expense: t.transaction.expense,
    income: t.transaction.income,
    transfer: t.transaction.transfer,
  };

  async function handleSubmit(formData: FormData) {
    setPending(true);
    setError(null);

    const payload = {
      kind,
      occurredOn: String(formData.get('occurredOn') ?? ''),
      amount: String(formData.get('amount') ?? ''),
      currency: String(formData.get('currency') ?? ''),
      moneyAccountId: String(formData.get('moneyAccountId') ?? ''),
      counterAccountId: formData.get('counterAccountId')
        ? String(formData.get('counterAccountId'))
        : undefined,
      categoryId: formData.get('categoryId') ? String(formData.get('categoryId')) : undefined,
      description: String(formData.get('description') ?? ''),
      exchangeRate: String(formData.get('exchangeRate') ?? '1'),
      clientUuid,
    };

    try {
      await createTransaction(orgSlug, payload);
      router.push(`/${orgSlug}/transactions`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form action={handleSubmit} className="transaction-form">
      <fieldset>
        <legend>{t.transaction.kind}</legend>
        {KINDS.map((option) => (
          <label key={option} className="kind-option">
            <input
              type="radio"
              name="kind"
              value={option}
              checked={kind === option}
              onChange={() => setKind(option)}
            />
            {kindLabels[option]}
          </label>
        ))}
      </fieldset>

      <label htmlFor="occurredOn">{t.transaction.date}</label>
      <input
        id="occurredOn"
        name="occurredOn"
        type="date"
        required
        value={occurredOn}
        onChange={(event) => setOccurredOn(event.target.value)}
      />

      <label htmlFor="amount">{t.transaction.amount}</label>
      <input
        id="amount"
        name="amount"
        inputMode="decimal"
        required
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />

      <label htmlFor="currency">{t.transaction.currency}</label>
      <select
        id="currency"
        name="currency"
        value={currency}
        onChange={(event) => setCurrency(event.target.value)}
      >
        {currencies.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>

      <RateField
        orgSlug={orgSlug}
        currency={currency}
        baseCurrency={baseCurrency}
        occurredOn={occurredOn}
        amount={amount}
        locale={locale}
      />

      <label htmlFor="moneyAccountId">
        {kind === 'transfer' ? t.transaction.destinationAccount : t.transaction.moneyAccount}
      </label>
      <select id="moneyAccountId" name="moneyAccountId" required>
        {moneyAccounts.map((account) => (
          <option key={account.id} value={account.id}>
            {localizedName(account, locale)}
          </option>
        ))}
      </select>

      {kind === 'transfer' ? (
        <>
          <label htmlFor="counterAccountId">{t.transaction.moneyAccount}</label>
          <select id="counterAccountId" name="counterAccountId" required>
            {moneyAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {localizedName(account, locale)}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label htmlFor="categoryId">{t.transaction.category}</label>
          <select id="categoryId" name="categoryId" required>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {localizedName(category, locale)}
              </option>
            ))}
          </select>
        </>
      )}

      <label htmlFor="description">{t.transaction.description}</label>
      <input id="description" name="description" maxLength={500} />

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <button type="submit" disabled={pending}>
        {pending ? t.common.loading : t.transaction.save}
      </button>
    </form>
  );
}
