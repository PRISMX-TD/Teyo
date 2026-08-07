import Link from 'next/link';
import { RecurringList } from '@/components/settings/recurring-list';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listRecurring } from '@/server/repositories/recurring';
import { listMoneyAccounts, listAllAccounts } from '@/server/repositories/accounts';
import { listCategories } from '@/server/repositories/categories';
import {
  createRecurring,
  editRecurring,
  toggleRecurring,
  generateDueRecurring,
} from '@/server/actions/recurring';

export default async function RecurringSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const [entries, moneyAccounts, allAccounts, categories] = await withTransaction(
    context.userId,
    async (tx) => {
      const [entries, moneyAccounts, allAccounts, categories] = await Promise.all([
        listRecurring(tx, context.organizationId),
        listMoneyAccounts(tx, context.organizationId),
        listAllAccounts(tx, context.organizationId),
        listCategories(tx, context.organizationId),
      ]);
      return [entries, moneyAccounts, allAccounts, categories] as const;
    },
  );

  return (
    <>
      <Link href={`/${orgSlug}/settings`} style={{ display: 'inline-block', marginBottom: 'var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        &larr; {locale === 'zh' ? '设置' : 'Settings'}
      </Link>
      <h1>{t.recurring.title}</h1>
      <RecurringList
        orgSlug={orgSlug}
        locale={locale}
        t={t}
        entries={entries.map((e) => ({
          id: e.id,
          kind: e.kind,
          description: e.description,
          amount: e.amount,
          currency: e.currency,
          debitAccountId: e.debitAccountId,
          creditAccountId: e.creditAccountId,
          categoryId: e.categoryId,
          frequency: e.frequency,
          interval: e.interval,
          startDate: e.startDate,
          endDate: e.endDate,
          nextDueDate: e.nextDueDate,
          isActive: e.isActive,
        }))}
        moneyAccounts={moneyAccounts}
        allAccounts={allAccounts.map((a) => ({
          id: a.id,
          code: a.code,
          nameEn: a.nameEn,
          nameZh: a.nameZh,
          type: a.type,
          isMoneyAccount: a.isMoneyAccount,
        }))}
        categories={categories}
        createAction={createRecurring as unknown as (orgSlug: string, input: Record<string, unknown>) => Promise<{ id: string }>}
        editAction={editRecurring as unknown as (orgSlug: string, id: string, fields: Record<string, unknown>) => Promise<void>}
        toggleAction={toggleRecurring as unknown as (orgSlug: string, id: string, active: boolean) => Promise<void>}
        generateAction={generateDueRecurring as unknown as (orgSlug: string) => Promise<{ generated: number }>}
      />
    </>
  );
}
