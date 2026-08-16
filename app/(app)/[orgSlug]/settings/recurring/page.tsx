import Link from 'next/link';
import { RecurringList } from '@/components/settings/recurring-list';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listRecurring } from '@/server/repositories/recurring';
import { listMoneyAccounts, listAllAccounts } from '@/server/repositories/accounts';
import { listSelectableCategories } from '@/server/repositories/categories';
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

  const [entries, moneyAccounts, allAccounts, incomeCategories, expenseCategories] =
    await withTransaction(context.userId, async (tx) => {
      const [entries, moneyAccounts, allAccounts, incomeCategories, expenseCategories] =
        await Promise.all([
          listRecurring(tx, context.organizationId),
          listMoneyAccounts(tx, context.organizationId),
          listAllAccounts(tx, context.organizationId),
          // 只取可由用户选的分类（排除折旧/摊销这类只应由系统过账的），
          // 理由同 transactions/[id]/page.tsx：定期规则每月自动生成交易，
          // 挂错在这类分类上会一直贷记资金账户，而这笔现金流出从未发生过。
          listSelectableCategories(tx, context.organizationId, 'income'),
          listSelectableCategories(tx, context.organizationId, 'expense'),
        ]);
      return [entries, moneyAccounts, allAccounts, incomeCategories, expenseCategories] as const;
    });
  const categories = [...incomeCategories, ...expenseCategories].map((c) => ({
    id: c.id,
    nameEn: c.nameEn,
    nameZh: c.nameZh,
    kind: c.kind,
  }));

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
        createAction={createRecurring}
        editAction={editRecurring}
        toggleAction={toggleRecurring}
        generateAction={generateDueRecurring}
      />
    </>
  );
}
