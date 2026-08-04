import Link from 'next/link';
import { JournalForm } from '@/components/transaction/journal-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listAllAccounts } from '@/server/repositories/accounts';

export default async function JournalPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const accounts = await withTransaction(context.userId, (tx) =>
    listAllAccounts(tx, context.organizationId),
  );

  const active = accounts.filter((a) => a.isActive);

  return (
    <>
      <Link href={`/${orgSlug}/transactions`}>&larr; {t.transaction.listTitle}</Link>
      <h1>{t.journal.newTitle}</h1>
      <JournalForm
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        locale={locale}
        accounts={active.map((a) => ({
          id: a.id,
          name_en: a.nameEn,
          name_zh: a.nameZh,
          type: a.type,
        }))}
      />
    </>
  );
}
