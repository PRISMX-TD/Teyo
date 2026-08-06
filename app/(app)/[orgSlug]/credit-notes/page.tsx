import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listCreditNotes } from '@/server/repositories/credit_notes';
import { CreditNoteList } from '@/components/credit-notes/credit-note-list';

export default async function CreditNotesListPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const creditNotes = await withTransaction(context.userId, async (tx) =>
    listCreditNotes(tx, context.organizationId),
  );

  return (
    <>
      <h1>{t.creditNotes.title}</h1>
      <Link href={`/${orgSlug}/credit-notes/new`} className="primary-button">
        {t.creditNotes.newTitle}
      </Link>

      <CreditNoteList
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        creditNotes={creditNotes}
      />
    </>
  );
}
