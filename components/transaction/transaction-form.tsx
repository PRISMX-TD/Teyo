'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { RateField } from '@/components/transaction/rate-field';
import { AttachmentPanel } from '@/components/transaction/attachment-panel';
import { createTransaction, updateTransaction, voidTransaction } from '@/server/actions/transactions';
import { enqueueOfflineTransaction, isOnline, isRetriable } from '@/lib/offline-queue';

type Option = { id: string; name_en: string | null; name_zh: string | null };

type EditData = {
  id: string;
  occurredOn: string;
  amount: string;
  currency: string;
  moneyAccountId: string;
  categoryId: string | null;
  counterAccountId: string | null;
  description: string;
  exchangeRate: string;
  kind: 'income' | 'expense' | 'transfer';
};

type Attachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

type Props = {
  orgSlug: string;
  baseCurrency: string;
  locale: Locale;
  moneyAccounts: Option[];
  incomeCategories: Option[];
  expenseCategories: Option[];
  currencies: string[];
  /** 编辑模式时传入已有数据 */
  mode?: 'create' | 'edit';
  initialData?: EditData;
  attachments?: Attachment[];
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
  mode = 'create',
  initialData,
  attachments = [],
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const isEdit = mode === 'edit';

  const [kind, setKind] = useState<Kind>(initialData?.kind ?? 'expense');
  const [currency, setCurrency] = useState(initialData?.currency ?? baseCurrency);
  const [occurredOn, setOccurredOn] = useState(
    () => initialData?.occurredOn ?? new Date().toISOString().slice(0, 10),
  );
  const [amount, setAmount] = useState(initialData?.amount ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [savedOffline, setSavedOffline] = useState(false);
  const [voidDialog, setVoidDialog] = useState(false);
  const [voidReason, setVoidReason] = useState('');

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
      // RateField renders no exchangeRate field for domestic currency (see
      // components/transaction/rate-field.tsx) so createTransaction/updateTransaction
      // can take the currency === baseCurrency branch and record source 'auto'.
      // Defaulting this to '1' would resurrect the bug the field's removal fixes:
      // every transaction would be stamped rate_source='manual' again.
      exchangeRate: formData.get('exchangeRate') ? String(formData.get('exchangeRate')) : undefined,
      clientUuid,
    };

    try {
      if (isEdit && initialData) {
        await updateTransaction(orgSlug, initialData.id, payload);
      } else {
        await createTransaction(orgSlug, payload);
      }
      router.push(`/${orgSlug}/transactions`);
    } catch (e) {
      const message = (e as Error)?.message ?? '';
      const isNetwork = !isOnline() || isRetriable(e);

      if (isNetwork && !isEdit) {
        // clientUuid is fixed for the lifetime of this form instance and the
        // server dedupes on it, so replaying this entry from the queue is safe.
        // Offline is create-only: editing needs conflict-merge UI, deferred per spec.
        await enqueueOfflineTransaction(orgSlug, payload);
        setSavedOffline(true);
        return;
      }
      setError(message);
    } finally {
      setPending(false);
    }
  }

  async function handleVoid() {
    if (!initialData || !voidReason.trim()) return;
    setPending(true);
    setError(null);
    try {
      await voidTransaction(orgSlug, initialData.id, voidReason);
      router.push(`/${orgSlug}/transactions`);
    } catch (e) {
      setError((e as Error).message);
      setVoidDialog(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
    <form action={handleSubmit} className="transaction-form">
      {savedOffline ? (
        <p role="status" className="form-success">
          {t.transaction.savedOffline}
        </p>
      ) : null}

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
        {kind === 'transfer' ? t.transaction.destinationAccount : t.transaction.chooseMoneyAccount}
      </label>
      <select id="moneyAccountId" name="moneyAccountId" required defaultValue={initialData?.moneyAccountId ?? ''}>
        <option value="" disabled>
          {t.transaction.choosePlaceholder}
        </option>
        {moneyAccounts.map((account) => (
          <option key={account.id} value={account.id}>
            {localizedName(account, locale)}
          </option>
        ))}
      </select>

      {kind === 'transfer' ? (
        <>
          <label htmlFor="counterAccountId">{t.transaction.moneyAccount}</label>
          <select id="counterAccountId" name="counterAccountId" required defaultValue={initialData?.counterAccountId ?? ''}>
            <option value="" disabled>
              {t.transaction.choosePlaceholder}
            </option>
            {moneyAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {localizedName(account, locale)}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label htmlFor="categoryId">{t.transaction.chooseCategory}</label>
          <select id="categoryId" name="categoryId" required defaultValue={initialData?.categoryId ?? ''}>
            <option value="" disabled>
              {t.transaction.choosePlaceholder}
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {localizedName(category, locale)}
              </option>
            ))}
          </select>
        </>
      )}

      <label htmlFor="description">{t.transaction.description}</label>
      <input id="description" name="description" maxLength={500} defaultValue={initialData?.description ?? undefined} />

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" disabled={pending || savedOffline}>
          {pending ? t.common.loading : isEdit ? t.transaction.save : t.transaction.save}
        </button>

        {isEdit ? (
          <button
            type="button"
            className="btn-danger"
            disabled={pending}
            onClick={() => setVoidDialog(true)}
          >
            {t.transaction.void}
          </button>
        ) : null}
      </div>

      {voidDialog ? (
        <dialog open className="void-dialog">
          <p>{t.transaction.voidReason}</p>
          <input
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            placeholder={t.transaction.voidReason}
            autoFocus
          />
          <div className="void-dialog-actions">
            <button type="button" onClick={() => setVoidDialog(false)}>
              {t.common.cancel}
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={!voidReason.trim() || pending}
              onClick={handleVoid}
            >
              {t.transaction.void}
            </button>
          </div>
        </dialog>
      ) : null}
    </form>

    {isEdit && initialData ? (
      <AttachmentPanel
        orgSlug={orgSlug}
        transactionId={initialData.id}
        attachments={attachments}
        t={t}
      />
    ) : null}
  </>);
}
