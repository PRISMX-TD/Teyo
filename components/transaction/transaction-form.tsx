'use client';

import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate, localizedName } from '@/lib/i18n';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import { ModalDialog } from '@/components/shell/modal-dialog';
import { RateField } from '@/components/transaction/rate-field';
import { AttachmentPanel } from '@/components/transaction/attachment-panel';
import { CategoryChips } from '@/components/transaction/category-chips';
import {
  createJournal,
  createTransaction,
  updateTransaction,
  voidTransaction,
} from '@/server/actions/transactions';
import { enqueueOfflineTransaction, isOnline, neverReachedServer } from '@/lib/offline-queue';
import type { Scenario } from '@/server/domain/scenario';
import { todayLocalISO } from '@/lib/date';

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
  rateSource: 'auto' | 'manual';
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
  // 受控（原来是 defaultValue）：这样「再记一笔」重建表单时它不会被一起
  // 清空——连续录入时资金账户通常就是同一个。
  const [moneyAccountId, setMoneyAccountId] = useState(initialData?.moneyAccountId ?? '');
  const [currency, setCurrency] = useState(initialData?.currency ?? baseCurrency);
  const [occurredOn, setOccurredOn] = useState(
    () => initialData?.occurredOn ?? todayLocalISO(),
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
  const voidReasonId = useId();
  const amountErrorId = useId();

  /**
   * 金额的即时校验。
   *
   * 全站 aria-invalid / aria-describedby 的用量原来是 0，而 globals.css 里
   * 一直写着 `input[aria-invalid='true'] { border-color: var(--red) }`——
   * 那条规则从来没有被触发过。这里是让它活过来的第一处，也是最该有的一处：
   * 金额是这张表单的主字段。
   *
   * 校验条件刻意和服务端 parseDecimalToMinor 的那两条完全一致（非负十进制、
   * 小数位不超过币种的 exponent），不另立一套更松或更严的规则——前端说「行」
   * 而服务端说「不行」，比根本不校验还糟。
   *
   * 只在用户打完（有内容）时才判，空值交给 required：一进页面就把空的金额
   * 框标红，是在为用户还没做的事责备他。
   */
  const amountIssue = (() => {
    const raw = amount.trim();
    if (!raw) return null;

    let places: number;
    try {
      places = currencyExponent(currency);
    } catch {
      // 币种码不合法时说不出小数位应该是几，这时不对金额下结论。
      return null;
    }

    try {
      parseDecimalToMinor(raw, places);
      return null;
    } catch {
      // parseDecimalToMinor 的两种失败分开报：小数位太多是一条具体的、
      // 用户自己能改的信息（JPY 不收分），笼统的「格式不对」帮不上忙。
      const normalized = raw.replace(/,/g, '');
      if (/^\d+(\.\d+)?$/.test(normalized)) {
        return interpolate(t.transaction.amountTooPrecise, { places });
      }
      return t.transaction.amountInvalid;
    }
  })();

  // 「再记一笔」按下时 +1。它唯一的作用是换掉下面那个 clientUuid：
  // 幂等键是按「这一份表单」发的，沿用上一笔的键提交第二笔，服务端会
  // 认出是重复提交并直接返回上一笔，第二笔就这么凭空消失了。
  const [entryGeneration, setEntryGeneration] = useState(0);

  // 幂等键在一笔记录的录入过程中固定，重复提交不会产生重复账目。
  // exhaustive-deps 认为 entryGeneration 是「多余依赖」，因为
  // crypto.randomUUID() 没有用到它——但这里要的恰恰是这个副作用：
  // 依赖变了就重新生成一个键。这是 useMemo 少见的正当反模式用法，
  // 规则的模型看不出来，所以单行关掉。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clientUuid = useMemo(() => crypto.randomUUID(), [entryGeneration]);

  /**
   * 柜台前连着记五笔的出口。
   *
   * 离线存下之后提交按钮会被 disable（防止同一笔被排两次队），但在这之前
   * 页面上没有任何「下一笔」的入口——用户只能自己去点侧栏再进一次「记一笔」。
   *
   * entryGeneration 同时作为 <form> 的 key：换 key 会重建整棵表单子树，把
   * description 这类非受控输入框也一并清空（只重置 state 的话它会留着上一笔
   * 的备注）。日期和资金账户是受控 state 且不在这里清——连着录五张收据时
   * 这两项几乎不变；金额每次都不同，留着上一笔的数字比空着危险得多。
   */
  function startAnotherEntry() {
    setEntryGeneration((n) => n + 1);
    setSavedOffline(false);
    setError(null);
    setAmount('');
    setCategoryId('');
    setDirection(null);
  }

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

      const journalPayload = {
        kind: 'journal' as const,
        occurredOn: String(formData.get('occurredOn') ?? ''),
        amount: String(formData.get('amount') ?? ''),
        currency: baseCurrency,
        debitAccountId,
        creditAccountId,
        description: String(formData.get('description') ?? ''),
        // Same clientUuid the form was created with — fixed for its lifetime,
        // so a replay from the offline queue or a double-tap after a lost
        // response dedupes on the server instead of posting twice.
        clientUuid,
      };

      try {
        await createJournal(orgSlug, journalPayload);
        router.push(`/${orgSlug}/transactions`);
      } catch (e) {
        const message = (e as Error)?.message ?? '';
        const isNetwork = !isOnline() || neverReachedServer(e);

        if (isNetwork) {
          // Same offline safety net as every other scenario card gets below —
          // this branch used to return before ever reaching it, so a lost
          // response here meant a silently dropped entry instead of a queued one.
          await enqueueOfflineTransaction(orgSlug, journalPayload);
          setSavedOffline(true);
          return;
        }
        setError(message);
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
      const isNetwork = !isOnline() || neverReachedServer(e);

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
    <form key={entryGeneration} action={handleSubmit} className="transaction-form">
      {savedOffline ? (
        <div role="status" className="form-success">
          <p>{t.transaction.savedOffline}</p>
          {/* 提交按钮此刻是 disabled 的（同一笔不能排两次队），所以这个
              出口必须和提示待在一起——否则用户只能自己导航离开。 */}
          <button type="button" className="text-button" onClick={startAnotherEntry}>
            {t.transaction.addAnother}
          </button>
        </div>
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
        // aria-invalid 同时是红框的样式钩子和读屏听到的「这一项有问题」，
        // 两者共用一个来源，不会出现只改了一半的状态。
        aria-invalid={amountIssue ? true : undefined}
        aria-describedby={amountIssue ? amountErrorId : undefined}
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
      />
      {amountIssue ? (
        // 不用 role="alert"：用户还在这个框里打字，每敲一个字符就打断一次
        // 朗读会让人没法继续输入。aria-describedby 已经把它挂在输入框上，
        // 焦点回到金额时读屏会连着念出来。
        <p id={amountErrorId} className="field-error">
          {amountIssue}
        </p>
      ) : null}

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
            initialRate={isEdit ? initialData?.exchangeRate : undefined}
            initialSource={isEdit ? initialData?.rateSource : undefined}
          />
        </>
      ) : null}

      <label htmlFor="moneyAccountId">
        {kind === 'transfer' ? t.transaction.destinationAccount : t.transaction.chooseMoneyAccount}
      </label>
      <select
        id="moneyAccountId"
        name="moneyAccountId"
        required
        value={moneyAccountId}
        onChange={(event) => setMoneyAccountId(event.target.value)}
      >
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
          {/* counterAccountId is the transfer's source — templateFor credits
              it (see server/domain/posting-templates.ts, the one place that
              decides posting direction). moneyAccountId above
              is the destination ("Transfer into"). Sharing the generic
              moneyAccount label here made both fields read as destinations
              top to bottom, and a reversed source/destination entry still
              balances and still leaves the dashboard's total unchanged, so
              nothing on screen would look wrong. */}
          <label htmlFor="counterAccountId">{t.transaction.sourceAccount}</label>
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
          // amountIssue 也拦提交：让用户点下去、等一圈、再收到一条服务端
          // 的英文错误，和当场告诉他「填个数字」相比毫无好处。
          disabled={
            pending || savedOffline || amountIssue !== null || (isJournalScenario && direction === null)
          }
        >
          {/* 原来这里是 `isEdit ? t.transaction.save : t.transaction.save`，
              两个分支同一个值，isEdit 这个判断从来没起过作用。新增和编辑
              确实都叫「保存」，所以删掉判断而不是补一个不同的文案。 */}
          {pending ? t.common.loading : t.transaction.save}
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

    </form>

    {/* 对话框刻意留在 <form> 外面。<dialog> 即使用 showModal() 提到 top
        layer，在 DOM 上仍然是 form 的后代，所以它里面的输入框按回车会触发
        外层表单的隐式提交——在「确认作废」这个框里按回车，结果是把交易
        保存一遍。 */}
    <ModalDialog
      open={voidDialog}
      onClose={() => setVoidDialog(false)}
      title={t.transaction.void}
    >
      <label htmlFor={voidReasonId}>{t.transaction.voidReason}</label>
      <input
        id={voidReasonId}
        value={voidReason}
        onChange={(e) => setVoidReason(e.target.value)}
        autoFocus
      />
      <div className="app-dialog-actions">
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
    </ModalDialog>

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
