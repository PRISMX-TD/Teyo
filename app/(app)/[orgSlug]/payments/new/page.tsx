import { PaymentForm } from '@/components/payments/payment-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewPaymentPage({
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
        and is_active = true
      order by name
    ` as { id: string; name: string }[];
    return rows;
  });

  if (contacts.length === 0) {
    return (
      <>
        <h1>{t.payments.newTitle}</h1>
        <p className="empty-state">{t.payments.noContacts}</p>
      </>
    );
  }

  return (
    <>
      <h1>{t.payments.newTitle}</h1>
      <PaymentForm
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        contacts={contacts}
        type="received"
        currencies={[...SUPPORTED_CURRENCIES]}
      />
    </>
  );
}
