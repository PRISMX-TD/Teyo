'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { createJournal } from '@/server/actions/transactions';

type Option = { id: string; name_en: string | null; name_zh: string | null; type: string };

type Props = {
  orgSlug: string;
  baseCurrency: string;
  locale: Locale;
  accounts: Option[];
};

const TYPE_LABELS: Record<string, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense',
};

export function JournalForm({ orgSlug, baseCurrency, locale, accounts }: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const [occurredOn, setOccurredOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [debitAccountId, setDebitAccountId] = useState('');
  const [creditAccountId, setCreditAccountId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // 幂等键在表单整个生命周期内固定，重复提交不会产生重复账目——与
  // transaction-form.tsx 的 clientUuid 同一道理。
  const clientUuid = useMemo(() => crypto.randomUUID(), []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      await createJournal(orgSlug, {
        occurredOn,
        amount,
        currency: baseCurrency,
        debitAccountId,
        creditAccountId,
        description,
        clientUuid,
      });
      router.push(`/${orgSlug}/transactions`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const grouped = new Map<string, Option[]>();
  for (const a of accounts) {
    const g = grouped.get(a.type) ?? [];
    g.push(a);
    grouped.set(a.type, g);
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label htmlFor="occurredOn">{t.transaction.date}</label>
      <input
        id="occurredOn"
        type="date"
        required
        value={occurredOn}
        onChange={(e) => setOccurredOn(e.target.value)}
      />

      <label htmlFor="amount">{t.transaction.amount}</label>
      <input
        id="amount"
        inputMode="decimal"
        required
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      <label htmlFor="debitAccount">{t.journal.debitAccount}</label>
      <select
        id="debitAccount"
        required
        value={debitAccountId}
        onChange={(e) => setDebitAccountId(e.target.value)}
      >
        <option value="" disabled>
          {t.journal.selectAccount}
        </option>
        {[...grouped.entries()].map(([type, options]) => (
          <optgroup key={type} label={TYPE_LABELS[type] ?? type}>
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {localizedName(a, locale)} ({a.name_en || a.name_zh})
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <label htmlFor="creditAccount">{t.journal.creditAccount}</label>
      <select
        id="creditAccount"
        required
        value={creditAccountId}
        onChange={(e) => setCreditAccountId(e.target.value)}
      >
        <option value="" disabled>
          {t.journal.selectAccount}
        </option>
        {[...grouped.entries()].map(([type, options]) => (
          <optgroup key={type} label={TYPE_LABELS[type] ?? type}>
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {localizedName(a, locale)} ({a.name_en || a.name_zh})
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <label htmlFor="description">{t.transaction.description}</label>
      <input
        id="description"
        maxLength={500}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" disabled={pending}>
          {pending ? t.common.loading : t.journal.save}
        </button>
      </div>
    </form>
  );
}
