import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';
import { listCreditNotes } from '@/server/repositories/credit-notes';
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

  // 新建 / 签发 / 抵扣 / 作废都要 transaction:create；viewer 只读。
  const canWrite = can(context.role, 'transaction:create');

  return (
    <>
      <div className="page-header">
        <h1>{t.creditNotes.title}</h1>
        {canWrite ? (
          <div className="page-header-actions">
            <Link href={`/${orgSlug}/credit-notes/new`} className="primary-button">
              {t.creditNotes.newTitle}
            </Link>
          </div>
        ) : null}
      </div>

      <CreditNoteList
        orgSlug={orgSlug}
        locale={locale}
        baseCurrency={context.baseCurrency}
        i18n={t}
        creditNotes={creditNotes}
        canWrite={canWrite}
      />
    </>
  );
}
