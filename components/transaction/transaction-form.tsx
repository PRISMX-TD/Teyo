'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { RateField } from '@/components/transaction/rate-field';
import { AttachmentPanel } from '@/components/transaction/attachment-panel';
import { CategoryChips } from '@/components/transaction/category-chips';
import {
  createJournal,
  createTransaction,
  updateTransaction,
  voidTransaction,
} from '@/server/actions/transactions';
import { enqueueOfflineTransaction, isOnline, isRetriable } from '@/lib/offline-queue';
import type { Scenario } from '@/server/domain/scenario';

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
  /**
   * 该公司最近 90 天用得最多的分类（Task 15），已经按 kind 分好、排除了
   * 只应由系统过账的分类。缺省为空数组——CategoryChips 空数组时不渲染
   * 芯片行，下拉照常独立工作，编辑页目前就是这么用的（未传这两个 prop）。
   */
  recentIncomeCategories?: Option[];
  recentExpenseCategories?: Option[];
  currencies: string[];
  /** 编辑模式时传入已有数据 */
  mode?: 'create' | 'edit';
  initialData?: EditData;
  attachments?: Attachment[];
  /** 场景卡片选中的场景（Task 14）。存在时表单按场景收窄字段。 */
  scenario?: Scenario;
  /**
   * 场景预设的分类 id（如 buy-stock → 「进货」），由页面按
   * scenario.defaultAccountCode 查出。scenario.needsCategory 为 false 且
   * scenario.kind 不是 journal 时使用，此时不再渲染分类下拉。
   */
  presetCategoryId?: string;
  /**
   * 场景预设的科目 id（目前只有 not-sure → 悬置科目）。scenario.kind 为
   * 'journal' 时使用：方向问题决定它落在借方还是贷方，绝不能预设方向。
   */
  presetAccountId?: string;
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
  recentIncomeCategories = [],
  recentExpenseCategories = [],
  currencies,
  mode = 'create',
  initialData,
  attachments = [],
  scenario,
  presetCategoryId,
  presetAccountId,
}: Props) {
  const t = getMessages(locale);
  const router = useRouter();
  const isEdit = mode === 'edit';

  // not-sure is the only scenario with kind 'journal'. It doesn't fit the
  // income/expense/transfer form at all — it posts through createJournal to
  // a debit/credit pair, not through createTransaction with a category.
  const isJournalScenario = scenario?.kind === 'journal';

  const [kind, setKind] = useState<Kind>(
    initialData?.kind ?? (scenario && scenario.kind !== 'journal' ? scenario.kind : 'expense'),
  );
  // Lifted out of the <select> (was defaultValue/uncontrolled) so a chip
  // click and picking from the dropdown are the same action: both just set
  // this value, and the select mirrors it back via value=. See handleSubmit
  // below — it still reads categoryId from formData, untouched, because the
  // select still carries name="categoryId" and this state drives its value.
  const [categoryId, setCategoryId] = useState(initialData?.categoryId ?? '');
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
  // The not-sure direction question. Starts at null — never preset, never
  // inferred. The suspense entry's debit/credit sides are derived from this
  // and only this; see handleSubmit's isJournalScenario branch.
  const [direction, setDirection] = useState<'in' | 'out' | null>(null);

  // 幂等键在表单整个生命周期内固定，重复提交不会产生重复账目
  const clientUuid = useMemo(() => crypto.randomUUID(), []);

  const categories = kind === 'income' ? incomeCategories : expenseCategories;
  const recentCategories = kind === 'income' ? recentIncomeCategories : recentExpenseCategories;
  const kindLabels: Record<Kind, string> = {
    expense: t.transaction.expense,
    income: t.transaction.income,
    transfer: t.transaction.transfer,
  };

  async function handleSubmit(formData: FormData) {
    setPending(true);
    setError(null);

    if (isJournalScenario) {
      // Belt and suspenders on top of the disabled submit button and the
      // native `required` radios below: this call cannot proceed without an
      // explicit direction. There is no fallback value — a missing direction
      // is a bug upstream, not something to paper over with a default.
      if (direction === null || !presetAccountId) {
        setError(t.scenario.directionRequired);
        setPending(false);
        return;
      }

      const moneyAccountId = String(formData.get('moneyAccountId') ?? '');
      // Money in = debit the money account, credit suspense.
      // Money out = debit suspense, credit the money account.
      const debitAccountId = direction === 'in' ? moneyAccountId : presetAccountId;
      const creditAccountId = direction === 'in' ? presetAccountId : moneyAccountId;

      try {
        await createJournal(orgSlug, {
          occurredOn: String(formData.get('occurredOn') ?? ''),
          amount: String(formData.get('amount') ?? ''),
          currency: baseCurrency,
          debitAccountId,
          creditAccountId,
          description: String(formData.get('description') ?? ''),
        });
        router.push(`/${orgSlug}/transactions`);
      } catch (e) {
        setError((e as Error)?.message ?? '');
      } finally {
        setPending(false);
      }
      return;
    }

    const payload = {
      kind,
      occurredOn: String(formData.get('occurredOn') ?? ''),
      amount: String(formData.get('amount') ?? ''),
      currency: String(formData.get('currency') ?? ''),
      moneyAccountId: String(formData.get('moneyAccountId') ?? ''),
      counterAccountId: formData.get('counterAccountId')
        ? String(formData.get('counterAccountId'))
        : undefined,
      // A scenario with needsCategory=false (buy-stock) never renders the
      // categoryId <select> below, so formData wouldn't carry one — fall
      // back to the id the page resolved from the scenario's default account.
      categoryId:
        presetCategoryId ??
        (formData.get('categoryId') ? String(formData.get('categoryId')) : undefined),
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

      {!scenario ? (
        <fieldset>
          <legend>{t.transaction.kind}</legend>
          {KINDS.map((option) => (
            <label key={option} className="kind-option">
              <input
                type="radio"
                name="kind"
                value={option}
                checked={kind === option}
                onChange={() => {
                  setKind(option);
                  // income/expense draw from different category pools; a
                  // categoryId picked under the old kind won't exist as an
                  // <option> under the new one.
                  setCategoryId('');
                }}
              />
              {kindLabels[option]}
            </label>
          ))}
        </fieldset>
      ) : null}

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

      {!isJournalScenario ? (
        <>
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
        </>
      ) : null}

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

      {isJournalScenario ? (
        // not-sure: the only thing left to ask is which way the money moved.
        // Both radios start unchecked (direction === null) — no default,
        // no inference. required on both means the browser itself won't
        // submit until one is picked, on top of the disabled submit button
        // and the handleSubmit guard above.
        <fieldset>
          <legend>{t.scenario.directionQuestion}</legend>
          <label className="direction-option">
            <input
              type="radio"
              name="direction"
              value="in"
              required
              checked={direction === 'in'}
              onChange={() => setDirection('in')}
            />
            {t.scenario.directionIn}
          </label>
          <label className="direction-option">
            <input
              type="radio"
              name="direction"
              value="out"
              required
              checked={direction === 'out'}
              onChange={() => setDirection('out')}
            />
            {t.scenario.directionOut}
          </label>
        </fieldset>
      ) : kind === 'transfer' ? (
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
      ) : scenario && !scenario.needsCategory ? null : (
        <>
          {/* Describes the chips + fallback select as a pair, so it is not
              `for`-bound to either one specifically — the select below has
              its own label immediately above it. */}
          <label>{t.transaction.chooseCategory}</label>
          <CategoryChips
            categories={recentCategories}
            selectedId={categoryId}
            onSelect={setCategoryId}
            locale={locale}
          />
          <label htmlFor="categoryId">{t.transaction.otherCategory}</label>
          <select
            id="categoryId"
            name="categoryId"
            required
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
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
        <button
          type="submit"
          disabled={pending || savedOffline || (isJournalScenario && direction === null)}
        >
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
