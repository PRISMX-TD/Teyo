import Link from 'next/link';
import { ScenarioPicker } from '@/components/transaction/scenario-picker';
import { TransactionForm } from '@/components/transaction/transaction-form';
import { getMessages, interpolate, type Locale } from '@/lib/i18n';
import { requirePermission, type OrgContext } from '@/server/auth/guard';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { canEditTransaction } from '@/server/domain/permissions';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import {
  findTransactionSource,
  getTransactionDetail,
  TransactionNotFoundError,
} from '@/server/repositories/transactions';
import { findAccountByCode, listMoneyAccounts } from '@/server/repositories/accounts';
import {
  listRecentCategories,
  listSelectableCategories,
  type CategoryRow,
} from '@/server/repositories/categories';
import { getUserLocale } from '@/server/repositories/organizations';
import { listProjects } from '@/server/repositories/projects';
import { scenarioById, type Scenario } from '@/server/domain/scenario';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

// A scenario id an experienced user reaches for the classic type/account/category
// form directly instead of picking a card. It deliberately does not collide with
// any ScenarioId in server/domain/scenario.ts, so scenarioById() below never
// resolves it — the branch is handled before that lookup runs.
const ADVANCED = 'advanced';

const toOption = (row: { id: string; nameEn: string | null; nameZh: string | null }) => ({
  id: row.id,
  name_en: row.nameEn,
  name_zh: row.nameZh,
});

async function loadFormData(tx: Tx, organizationId: string) {
  const [
    moneyAccounts,
    incomeCategories,
    expenseCategories,
    recentIncomeCategories,
    recentExpenseCategories,
    projects,
  ] = await Promise.all([
    listMoneyAccounts(tx, organizationId),
    listSelectableCategories(tx, organizationId, 'income'),
    listSelectableCategories(tx, organizationId, 'expense'),
    listRecentCategories(tx, organizationId, 'income'),
    listRecentCategories(tx, organizationId, 'expense'),
    listProjects(tx, organizationId),
  ]);
  return {
    moneyAccounts,
    incomeCategories,
    expenseCategories,
    recentIncomeCategories,
    recentExpenseCategories,
    // 只给还在进行中的项目。已完成/已取消的项目不该继续接收新交易，
    // 但它们在项目列表里仍然看得到历史。
    projects: projects
      .filter((project) => project.status === 'active')
      .map((project) => ({ id: project.id, name: project.name })),
  };
}

export default async function NewTransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const raw = await searchParams;
  const scenarioParam = typeof raw.scenario === 'string' ? raw.scenario : undefined;

  const context = await requirePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as Locale;
  const t = getMessages(locale);

  // 换类型重录：从编辑页的「改成收入 / 支出 / 转账」链接进来。
  if (typeof raw.replace === 'string') {
    return (
      <ReplaceEntry
        orgSlug={orgSlug}
        context={context}
        locale={locale}
        originalId={raw.replace}
        kindParam={typeof raw.kind === 'string' ? raw.kind : ''}
      />
    );
  }

  // Advanced escape hatch: the original, fully manual form — kind radio,
  // category dropdown and all. Reachable from the scenario picker's
  // "skip this" link so an experienced user is never forced through a card.
  if (scenarioParam === ADVANCED) {
    const {
      moneyAccounts,
      incomeCategories,
      expenseCategories,
      recentIncomeCategories,
      recentExpenseCategories,
      projects,
    } = await withTransaction(context.userId, (tx) => loadFormData(tx, context.organizationId));

    return (
      <>
        <h1>{t.transaction.newTitle}</h1>
        <TransactionForm
          orgSlug={orgSlug}
          baseCurrency={context.baseCurrency}
          locale={locale}
          moneyAccounts={moneyAccounts.map(toOption)}
          incomeCategories={incomeCategories.map(toOption)}
          expenseCategories={expenseCategories.map(toOption)}
          recentIncomeCategories={recentIncomeCategories.map(toOption)}
          recentExpenseCategories={recentExpenseCategories.map(toOption)}
          currencies={[...SUPPORTED_CURRENCIES]}
          projects={projects}
        />
      </>
    );
  }

  const scenario = scenarioParam ? scenarioById(scenarioParam) : undefined;

  // No value, or an unrecognised one: show the cards.
  if (!scenario) {
    return <ScenarioPicker orgSlug={orgSlug} locale={locale} />;
  }

  const {
    moneyAccounts,
    incomeCategories,
    expenseCategories,
    recentIncomeCategories,
    recentExpenseCategories,
    projects,
    presetCategoryId,
    presetAccountId,
  } = await withTransaction(context.userId, (tx) => loadScenarioFormData(tx, context, scenario));

  return (
    <>
      <h1>{t.transaction.newTitle}</h1>
      <TransactionForm
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        locale={locale}
        moneyAccounts={moneyAccounts.map(toOption)}
        incomeCategories={incomeCategories.map(toOption)}
        expenseCategories={expenseCategories.map(toOption)}
        recentIncomeCategories={recentIncomeCategories.map(toOption)}
        recentExpenseCategories={recentExpenseCategories.map(toOption)}
        currencies={[...SUPPORTED_CURRENCIES]}
        projects={projects}
        scenario={scenario}
        presetCategoryId={presetCategoryId}
        presetAccountId={presetAccountId}
      />
    </>
  );
}

const USER_KINDS = ['income', 'expense', 'transfer'] as const;
type UserKind = (typeof USER_KINDS)[number];

/**
 * 换类型重录的表单：拿原记录预填，类型换成链接上指定的那一种。
 *
 * 能不能换，这里按 replaceTransaction 会拒的那几条先判一遍——已作废、无权改、
 * 凭证或年结、单据生成的分录——判不过就只给一句说明和一个回去的链接，
 * 而不是让用户把表单填完、点保存才被服务端拒掉。服务端那一道照样在。
 */
async function ReplaceEntry({
  orgSlug,
  context,
  locale,
  originalId,
  kindParam,
}: {
  orgSlug: string;
  context: OrgContext;
  locale: Locale;
  originalId: string;
  kindParam: string;
}) {
  const t = getMessages(locale);
  const kind = USER_KINDS.find((option) => option === kindParam);

  const loaded = await withTransaction(context.userId, async (tx) => {
    // 原记录先单独取：查不到时 getTransactionDetail 立刻抛，若和下面几条
    // 查询放进同一个 Promise.all，事务会在那几条还没跑完时就被提交。
    let original;
    try {
      original = await getTransactionDetail(tx, context.organizationId, originalId);
    } catch (e) {
      if (e instanceof TransactionNotFoundError) return null;
      throw e;
    }
    const [source, formData] = await Promise.all([
      findTransactionSource(tx, context.organizationId, originalId),
      loadFormData(tx, context.organizationId),
    ]);
    return { original, source, formData };
  });

  const original = loaded?.original;
  const replaceable =
    loaded !== null &&
    original !== undefined &&
    kind !== undefined &&
    !original.voidedAt &&
    loaded.source === null &&
    original.kind !== kind &&
    (original.kind === 'income' || original.kind === 'expense' || original.kind === 'transfer') &&
    canEditTransaction(context.role, original.createdBy === context.userId);

  if (!replaceable || !loaded || !original || !kind) {
    return (
      <>
        <Link href={`/${orgSlug}/transactions/${originalId}`} className="back-link">
          &larr; {t.common.back}
        </Link>
        <p>{t.transaction.replaceUnavailable}</p>
      </>
    );
  }

  const kindLabels: Record<UserKind, string> = {
    income: t.transaction.income,
    expense: t.transaction.expense,
    transfer: t.transaction.transfer,
  };
  const { formData } = loaded;

  return (
    <>
      <Link href={`/${orgSlug}/transactions/${originalId}`} className="back-link">
        &larr; {t.transaction.editTitle}
      </Link>
      <h1>{interpolate(t.transaction.replaceTitle, { kind: kindLabels[kind] })}</h1>
      <p className="field-hint">{t.transaction.replaceExplain}</p>
      <TransactionForm
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        locale={locale}
        moneyAccounts={formData.moneyAccounts.map(toOption)}
        incomeCategories={formData.incomeCategories.map(toOption)}
        expenseCategories={formData.expenseCategories.map(toOption)}
        recentIncomeCategories={formData.recentIncomeCategories.map(toOption)}
        recentExpenseCategories={formData.recentExpenseCategories.map(toOption)}
        currencies={[...SUPPORTED_CURRENCIES]}
        projects={formData.projects}
        replacing={{ id: original.id }}
        initialData={{
          id: original.id,
          occurredOn: original.occurredOn,
          // 与编辑页同一把尺：按币种的小数位还原，不能 ÷100，见那里的注释。
          amount: formatMinorToDecimal(original.amountMinor, currencyExponent(original.currency)),
          currency: original.currency,
          moneyAccountId: original.moneyAccountId ?? '',
          // 收入与支出的分类是两个池子，换了类型原来那个分类在新下拉里不存在。
          categoryId: null,
          projectId: original.projectId ?? null,
          // 转账的转出方只有原记录本身就是转账时才有意义——而那时 kind 已经换掉了。
          counterAccountId: null,
          description: original.description ?? '',
          exchangeRate: original.exchangeRate ?? '1',
          rateSource: original.rateSource,
          kind,
        }}
      />
    </>
  );
}

async function loadScenarioFormData(tx: Tx, context: OrgContext, scenario: Scenario) {
  const [
    { moneyAccounts, incomeCategories, expenseCategories, recentIncomeCategories, recentExpenseCategories, projects },
    presetAccount,
  ] = await Promise.all([
    loadFormData(tx, context.organizationId),
    scenario.defaultAccountCode
      ? findAccountByCode(tx, context.organizationId, scenario.defaultAccountCode)
      : Promise.resolve(null),
  ]);

  // Two very different things share defaultAccountCode: buy-stock needs the
  // *category* that rolls up to that account (createTransaction takes a
  // categoryId, never an account id, for income/expense kinds); not-sure
  // needs the suspense *account* id itself, since createJournal posts
  // straight to accounts with no category involved at all.
  let presetCategoryId: string | undefined;
  let presetAccountId: string | undefined;
  if (presetAccount) {
    if (scenario.kind === 'journal') {
      presetAccountId = presetAccount.id;
    } else {
      const pool: CategoryRow[] = scenario.kind === 'income' ? incomeCategories : expenseCategories;
      presetCategoryId = pool.find((c) => c.accountId === presetAccount.id)?.id;
    }
  }

  return {
    moneyAccounts,
    incomeCategories,
    expenseCategories,
    recentIncomeCategories,
    recentExpenseCategories,
    projects,
    presetCategoryId,
    presetAccountId,
  };
}
