'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate, localizedName } from '@/lib/i18n';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import { ModalDialog } from '@/components/shell/modal-dialog';
import { RateField } from '@/components/transaction/rate-field';
import {
  AttachmentPanel,
  attachmentIssue,
  formatFileSize,
} from '@/components/transaction/attachment-panel';
import { CategoryChips } from '@/components/transaction/category-chips';
import {
  createJournal,
  createTransaction,
  replaceTransaction,
  updateTransaction,
  voidTransaction,
} from '@/server/actions/transactions';
import { uploadAttachment } from '@/server/actions/attachments';
import { ALLOWED_ATTACHMENT_TYPES } from '@/lib/upload-rules';
import { enqueueOfflineTransaction, isOnline, neverReachedServer } from '@/lib/offline-queue';
import type { Scenario } from '@/server/domain/scenario';
import { todayLocalISO } from '@/lib/date';

type Option = { id: string; name_en: string | null; name_zh: string | null };

/** 项目只有一个 name 列，没有中英两份，所以不走 Option。 */
type ProjectOption = { id: string; name: string };

type EditData = {
  id: string;
  occurredOn: string;
  amount: string;
  currency: string;
  moneyAccountId: string;
  categoryId: string | null;
  projectId: string | null;
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
  /**
   * 可以把这笔交易挂上去的项目。空数组时整个下拉不渲染——没有项目的公司
   * 不该多看一个永远只有「--」的框。
   *
   * 这个字段此前**在界面上根本不存在**。写入链路是齐的：lib/schemas.ts 的
   * transactionBase 有 projectId、server/actions/transactions.ts 传下去、
   * server/posting/insert.ts 还专门校验了它属不属于本公司。缺的只有表单
   * 这一端，于是 transactions.project_id 永远是 null，项目盈亏那张表
   * （getProjectProfitability）算出来的恒定是三个零——查询侧一直是对的，
   * 没有任何东西写过那一列。
   */
  projects?: ProjectOption[];
  /** 编辑模式时传入已有数据 */
  mode?: 'create' | 'edit';
  /**
   * 编辑时是这笔交易本身；换类型重录（replacing）时是被替换那一笔，用来预填
   * 日期、金额、账户与备注，kind 则已经换成了新的类型。
   */
  initialData?: EditData;
  /**
   * 换类型重录：新建模式，但保存走 replaceTransaction——新建这一笔、作废
   * replacing.id 那一笔、把收据挪过来，一个事务。类型由页面定死，不给选。
   */
  replacing?: { id: string };
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
  projects = [],
  mode = 'create',
  initialData,
  attachments = [],
  scenario,
  presetCategoryId,
  presetAccountId,
  replacing,
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
  const [projectId, setProjectId] = useState(initialData?.projectId ?? '');
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
  const voidReasonRef = useRef<HTMLInputElement>(null);
  const amountErrorId = useId();

  // 作废原因框只在有鼠标的设备上自动聚焦。触屏上一聚焦键盘就弹出来，
  // 底部弹层里的「作废 / 取消」被盖在键盘下面，得先收起键盘才点得到。
  // showModal() 自己也会把焦点给第一个输入框，所以触屏上要主动移开。
  useEffect(() => {
    if (!voidDialog) return;
    const input = voidReasonRef.current;
    if (!input) return;
    if (window.matchMedia('(pointer: fine)').matches) input.focus();
    else if (document.activeElement === input) input.blur();
  }, [voidDialog]);

  // 新建时就能挂上的收据。交易还没有 id，文件先留在浏览器里，保存成功之后
  // 再逐张上传——见 finishCreate。
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingIssue, setPendingIssue] = useState<string | null>(null);
  // 离线存下的那一笔带不走收据（离线队列只存表单字段），要明说，不能让
  // 用户以为收据也一起排了队。
  const [receiptsLeftBehind, setReceiptsLeftBehind] = useState(false);

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
    setPendingFiles([]);
    setPendingIssue(null);
    setReceiptsLeftBehind(false);
  }

  function addPendingFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const accepted: File[] = [];
    const issues: string[] = [];
    for (const file of Array.from(input.files ?? [])) {
      const issue = attachmentIssue(file, t);
      if (issue) issues.push(issue);
      else accepted.push(file);
    }
    setPendingFiles((prev) => [...prev, ...accepted]);
    setPendingIssue(issues.length > 0 ? issues.join('\n') : null);
    input.value = '';
  }

  /**
   * 交易已经入账之后，把选好的收据逐张传上去，再离开这一页。
   *
   * 收据传不上去不能让这笔账跟着失败：它已经是一笔完整的记录了。失败的那几张
   * 带着张数跳到这笔记录的详情页，那里就是同一个附件面板，用户当场补传。
   * 不并发上传，理由见 AttachmentPanel 的 handleUpload。
   */
  async function finishCreate(transactionId: string) {
    let failed = 0;
    for (const file of pendingFiles) {
      try {
        await uploadAttachment(orgSlug, transactionId, file);
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      router.push(`/${orgSlug}/transactions/${transactionId}?receiptsFailed=${failed}`);
      return;
    }
    router.push(`/${orgSlug}/transactions?saved=1`);
  }

  /** 网络断了、这一笔进了离线队列：收据留不住，清掉并说明。 */
  function dropPendingFilesForOffline() {
    if (pendingFiles.length > 0) {
      setReceiptsLeftBehind(true);
      setPendingFiles([]);
    }
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
        projectId: formData.get('projectId') ? String(formData.get('projectId')) : undefined,
      description: String(formData.get('description') ?? ''),
        // Same clientUuid the form was created with — fixed for its lifetime,
        // so a replay from the offline queue or a double-tap after a lost
        // response dedupes on the server instead of posting twice.
        clientUuid,
      };

      try {
        const created = await createJournal(orgSlug, journalPayload);
        await finishCreate(created.id);
      } catch (e) {
        const message = (e as Error)?.message ?? '';
        const isNetwork = !isOnline() || neverReachedServer(e);

        if (isNetwork) {
          // Same offline safety net as every other scenario card gets below —
          // this branch used to return before ever reaching it, so a lost
          // response here meant a silently dropped entry instead of a queued one.
          await enqueueOfflineTransaction(orgSlug, journalPayload);
          dropPendingFilesForOffline();
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
      projectId: formData.get('projectId') ? String(formData.get('projectId')) : undefined,
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
      // 在线保存此前一句回执都没有——只有离线那一支渲染了 savedOffline，
      // 于是「存进设备」有反馈、「真的存进账本」反而没有。?saved=1 让列表页
      // 接手说这句话；在这张表单上闪一下再跳走，用户看不见。
      if (isEdit && initialData) {
        await updateTransaction(orgSlug, initialData.id, payload);
        router.push(`/${orgSlug}/transactions?saved=1`);
      } else {
        const created = replacing
          ? await replaceTransaction(orgSlug, replacing.id, {
              ...payload,
              voidReason: interpolate(t.transaction.replaceVoidReason, { kind: kindLabels[kind] }),
            })
          : await createTransaction(orgSlug, payload);
        await finishCreate(created.id);
      }
    } catch (e) {
      const message = (e as Error)?.message ?? '';
      const isNetwork = !isOnline() || neverReachedServer(e);

      // 换类型重录不进离线队列：它要作废另一笔记录，和编辑一样需要当场确认
      // 原记录还是保存那一刻的样子。
      if (isNetwork && !isEdit && !replacing) {
        // clientUuid is fixed for the lifetime of this form instance and the
        // server dedupes on it, so replaying this entry from the queue is safe.
        // Offline is create-only: editing needs conflict-merge UI, deferred per spec.
        await enqueueOfflineTransaction(orgSlug, payload);
        dropPendingFilesForOffline();
        setSavedOffline(true);
        return;
      }
      setError(message);
    } finally {
      setPending(false);
    }
  }

  // 资金账户这一问按已知的方向说：收入问钱进了哪个账户，支出问从哪个账户付。
  // 只有「不确定」场景方向未知，才用两头都包的那句。
  const moneyAccountLabel = isJournalScenario
    ? t.transaction.chooseMoneyAccount
    : kind === 'transfer'
      ? t.transaction.destinationAccount
      : kind === 'income'
        ? t.transaction.moneyInAccount
        : t.transaction.moneyOutAccount;
  const moneyAccountField = (
    <>
      <label htmlFor="moneyAccountId">{moneyAccountLabel}</label>
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
    </>
  );

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
          {receiptsLeftBehind ? <p>{t.transaction.receiptsNotSavedOffline}</p> : null}
          {/* 提交按钮此刻是 disabled 的（同一笔不能排两次队），所以这个
              出口必须和提示待在一起——否则用户只能自己导航离开。 */}
          <button type="button" className="text-button" onClick={startAnotherEntry}>
            {t.transaction.addAnother}
          </button>
        </div>
      ) : null}

      {/* 编辑时不给改类型：updateTransaction 把 kind 钉在原值上，这里换了
          类型只会让分类下拉换成另一池、保存时被服务端拒掉。真要换类型走下面
          那几个链接——换类型重录的页面把类型定死，这里同样不给选。 */}
      {isEdit && initialData ? (
        // 两个链接之间不再夹「 · 」：手机上它们各自是 44px 高的点按目标，
        // 一行放不下时整条链接换行，不会只把分隔点甩到下一行。
        <p className="change-kind">
          <span>{t.transaction.changeKindHint}</span>
          {KINDS.filter((option) => option !== initialData.kind).map((option) => (
            <Link
              key={option}
              href={`/${orgSlug}/transactions/new?replace=${initialData.id}&kind=${option}`}
            >
              {interpolate(t.transaction.changeKindTo, { kind: kindLabels[option] })}
            </Link>
          ))}
        </p>
      ) : null}
      {!scenario && !isEdit && !replacing ? (
        <fieldset>
          <legend>{t.transaction.kind}</legend>
          {/* 分段控件：三选一，一眼看到当前是哪一种。 */}
          <div className="segmented">
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
          </div>
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
            initialRate={isEdit || replacing ? initialData?.exchangeRate : undefined}
            initialSource={isEdit || replacing ? initialData?.rateSource : undefined}
          />
        </>
      ) : null}

      {/* 转账的转入账户挪到下面「转出账户」之后渲染，见那里的注释。 */}
      {kind !== 'transfer' ? moneyAccountField : null}

      {isJournalScenario ? (
        // not-sure: the only thing left to ask is which way the money moved.
        // Both radios start unchecked (direction === null) — no default,
        // no inference. required on both means the browser itself won't
        // submit until one is picked, on top of the disabled submit button
        // and the handleSubmit guard above.
        <fieldset>
          <legend>{t.scenario.directionQuestion}</legend>
          <div className="segmented">
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
          </div>
        </fieldset>
      ) : kind === 'transfer' ? (
        <>
          {/* counterAccountId is the transfer's source — templateFor credits
              it (see server/domain/posting-templates.ts, the one place that
              decides posting direction). moneyAccountId below
              is the destination ("Transfer into"). Sharing the generic
              moneyAccount label here made both fields read as destinations
              top to bottom, and a reversed source/destination entry still
              balances and still leaves the dashboard's total unchanged, so
              nothing on screen would look wrong.
              先问转出、再问转入：人想转账就是「从 A 到 B」。原来转入在上，
              第一个下拉很容易顺手填成转出的那个户口，而填反了账照样是平的。
              只改渲染顺序，字段名不变。 */}
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
          {moneyAccountField}
        </>
      ) : scenario && !scenario.needsCategory && presetCategoryId ? null : (
        // presetCategoryId 查不到（这家公司没有挂在「进货」科目上的分类）时
        // 退回分类下拉，否则这张表单交上去必然报「需要分类」，而界面上
        // 没有任何能补救的地方。
        <>
          {/* Describes the chips + fallback select as a pair, so it is not
              `for`-bound to either one specifically — the select below has
              its own label immediately above it.
              没有常用分类（新公司、或最近 90 天没记过这一类）时芯片行不渲染，
              这时问题直接落在下拉上：不能留一句没有答案的问题，再跟一个
              「其他分类」——没有「其他」可言。 */}
          {recentCategories.length > 0 ? (
            <>
              <label>{t.transaction.chooseCategory}</label>
              <CategoryChips
                categories={recentCategories}
                selectedId={categoryId}
                onSelect={setCategoryId}
                locale={locale}
              />
            </>
          ) : null}
          <label htmlFor="categoryId">
            {recentCategories.length > 0 ? t.transaction.otherCategory : t.transaction.chooseCategory}
          </label>
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

      {/*
        项目归属。没有建过项目的公司不渲染这一段——多一个永远只有「--」的
        下拉，对绝大多数用户就是纯噪音。
      */}
      {projects.length > 0 && (
        <>
          <label htmlFor="projectId">{t.projects.title}</label>
          <select
            id="projectId"
            name="projectId"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">--</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </>
      )}

      <label htmlFor="description">{t.transaction.description}</label>
      {/* 多行框：备注常常是一整串转账参考号或一句长说明，单行框里只看得到
          开头十几个字。支持 field-sizing 的浏览器随内容长高（见 tx.css），
          rows={2} 是不支持时的退路。 */}
      <textarea
        id="description"
        name="description"
        className="tx-note"
        rows={2}
        maxLength={500}
        defaultValue={initialData?.description ?? undefined}
      />

      {/*
        新建时就能把收据挂上：站在柜台前录一笔，顺手拍张照，不必存完再进
        详情页找附件区。文件框不带 name，不会跟着表单字段一起提交——它们在
        finishCreate 里另行上传。编辑时不在这里：那时交易已经有 id，下面
        AttachmentPanel 选完即传。
      */}
      {!isEdit ? (
        <fieldset className="pending-receipts-field">
          <legend>{t.transaction.receipt}</legend>
          {pendingFiles.length > 0 ? (
            <ul className="pending-receipts">
              {pendingFiles.map((file, index) => (
                <li key={`${file.name}-${file.size}-${index}`}>
                  <span className="attachment-name">{file.name}</span>
                  <span className="attachment-size">{formatFileSize(file.size)}</span>
                  {/* 写字而不是一个 ×，理由同 attachment-panel.tsx。 */}
                  <button
                    type="button"
                    className="btn-small attachment-delete-btn"
                    aria-label={interpolate(t.transaction.receiptRemovePending, { name: file.name })}
                    onClick={() =>
                      setPendingFiles((prev) => prev.filter((_, position) => position !== index))
                    }
                  >
                    {t.transaction.receiptRemoveShort}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="attachment-upload-label">
            <input
              type="file"
              multiple
              accept={ALLOWED_ATTACHMENT_TYPES.join(',')}
              onChange={addPendingFiles}
              disabled={pending || savedOffline}
            />
            {`+ ${t.transaction.receiptAdd}`}
          </label>
          {pendingIssue ? (
            <p role="alert" className="field-error attachment-errors">
              {pendingIssue}
            </p>
          ) : null}
        </fieldset>
      ) : null}

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
        ref={voidReasonRef}
        id={voidReasonId}
        value={voidReason}
        onChange={(e) => setVoidReason(e.target.value)}
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
        owner={{ type: 'transaction', id: initialData.id }}
        attachments={attachments}
        t={t}
      />
    ) : null}

    {/* 作废不再和「保存」并排：原来两个一样大的胶囊挨着，红色那个英文下
        还更宽。挪到页面最底下、单独一整行红字（iOS 设置里危险操作的样子），
        「保存」是卡片里唯一的主按钮。 */}
    {isEdit ? (
      <button
        type="button"
        className="row-button is-destructive tx-void-row"
        disabled={pending}
        onClick={() => setVoidDialog(true)}
      >
        {t.transaction.void}
      </button>
    ) : null}
  </>);
}
