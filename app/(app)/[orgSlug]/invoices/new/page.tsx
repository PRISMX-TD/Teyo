import { InvoiceForm } from '@/components/invoices/invoice-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewInvoicePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const contacts = await withTransaction(context.userId, async (tx) => {
    const rows = await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('customer', 'both')
        and is_active = true
      order by name
    ` as { id: string; name: string }[];
    return rows;
  });

  if (contacts.length === 0) {
    return (
      <>
        <h1>{t.invoices.newTitle}</h1>
        <p className="empty-state">You need to add a customer contact first. Go to Settings → Categories to manage contacts.</p>
      </>
    );
  }

  return (
    <>
      <h1>{t.invoices.newTitle}</h1>
      <InvoiceForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={contacts}
        currencies={[...SUPPORTED_CURRENCIES]}
      />
    </>
  );
}
