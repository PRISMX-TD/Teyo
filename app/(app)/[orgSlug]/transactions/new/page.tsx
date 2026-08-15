import { ScenarioPicker } from '@/components/transaction/scenario-picker';
import { TransactionForm } from '@/components/transaction/transaction-form';
import { getMessages, type Locale } from '@/lib/i18n';
import { requirePermission, type OrgContext } from '@/server/auth/guard';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { findAccountByCode, listMoneyAccounts } from '@/server/repositories/accounts';
import { listSelectableCategories, type CategoryRow } from '@/server/repositories/categories';
import { getUserLocale } from '@/server/repositories/organizations';
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
  const [moneyAccounts, incomeCategories, expenseCategories] = await Promise.all([
    listMoneyAccounts(tx, organizationId),
    listSelectableCategories(tx, organizationId, 'income'),
    listSelectableCategories(tx, organizationId, 'expense'),
  ]);
  return { moneyAccounts, incomeCategories, expenseCategories };
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

  // Advanced escape hatch: the original, fully manual form — kind radio,
  // category dropdown and all. Reachable from the scenario picker's
  // "skip this" link so an experienced user is never forced through a card.
  if (scenarioParam === ADVANCED) {
    const { moneyAccounts, incomeCategories, expenseCategories } = await withTransaction(
      context.userId,
      (tx) => loadFormData(tx, context.organizationId),
    );

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
          currencies={[...SUPPORTED_CURRENCIES]}
        />
      </>
    );
  }

  const scenario = scenarioParam ? scenarioById(scenarioParam) : undefined;

  // No value, or an unrecognised one: show the cards.
  if (!scenario) {
    return <ScenarioPicker orgSlug={orgSlug} locale={locale} />;
  }

  const { moneyAccounts, incomeCategories, expenseCategories, presetCategoryId, presetAccountId } =
    await withTransaction(context.userId, (tx) =>
      loadScenarioFormData(tx, context, scenario),
    );

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
        currencies={[...SUPPORTED_CURRENCIES]}
        scenario={scenario}
        presetCategoryId={presetCategoryId}
        presetAccountId={presetAccountId}
      />
    </>
  );
}

async function loadScenarioFormData(tx: Tx, context: OrgContext, scenario: Scenario) {
  const [{ moneyAccounts, incomeCategories, expenseCategories }, presetAccount] = await Promise.all([
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

  return { moneyAccounts, incomeCategories, expenseCategories, presetCategoryId, presetAccountId };
}
