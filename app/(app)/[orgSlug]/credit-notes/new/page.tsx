import { CreditNoteForm } from '@/components/credit-notes/credit-note-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewCreditNotePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const [contacts, invoices] = await Promise.all([
    withTransaction(context.userId, async (tx) => {
      const rows = await tx`
        select id, name
        from contacts
        where organization_id = ${context.organizationId}
          and is_active = true
        order by name
      ` as { id: string; name: string }[];
      return rows;
    }),
    withTransaction(context.userId, async (tx) => {
      const rows = await tx`
        select id, invoice_number, total_minor
        from invoices
        where organization_id = ${context.organizationId}
          and status not in ('voided', 'paid')
        order by invoice_number
      ` as { id: string; invoice_number: string; total_minor: bigint }[];
      return rows;
    }),
  ]);

  if (contacts.length === 0) {
    return (
      <>
        <h1>{t.creditNotes.newTitle}</h1>
        <p className="empty-state">{t.creditNotes.noContacts}</p>
      </>
    );
  }

  return (
    <>
      <h1>{t.creditNotes.newTitle}</h1>
      <CreditNoteForm
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        contacts={contacts}
        invoices={invoices}
        currencies={[...SUPPORTED_CURRENCIES]}
      />
    </>
  );
}
