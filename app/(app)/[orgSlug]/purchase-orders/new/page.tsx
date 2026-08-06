import { PoForm } from '@/components/purchase-orders/po-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewPurchaseOrderPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const vendors = await withTransaction(context.userId, async (tx) => {
    const rows = await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('vendor', 'both')
        and is_active = true
      order by name
    ` as { id: string; name: string }[];
    return rows;
  });

  if (vendors.length === 0) {
    return (
      <>
        <h1>{t.purchaseOrders.newTitle}</h1>
        <p className="empty-state">You need to add a vendor contact first. Go to Settings → Contacts to manage contacts.</p>
      </>
    );
  }

  return (
    <>
      <h1>{t.purchaseOrders.newTitle}</h1>
      <PoForm
        orgSlug={orgSlug}
        locale={locale}
        vendors={vendors}
        currencies={[...SUPPORTED_CURRENCIES]}
      />
    </>
  );
}
