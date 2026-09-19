import { PoForm } from '@/components/purchase-orders/po-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listTaxRates } from '@/server/repositories/tax';
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

  const { vendors, taxRates } = await withTransaction(context.userId, async (tx) => {
    const rows = await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('vendor', 'both')
        and is_active = true
      order by name
    ` as { id: string; name: string }[];

    // 采购单明细的 tax_rate_id 是 tax_rates 上的外键。表单里原来那排
    // 写死的 0/6/10/12 对不上任何一条记录，所以它选什么都没往下传。
    const rates = await listTaxRates(tx, context.organizationId);
    return { vendors: rows, taxRates: rates };
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
        // 本位币：币种缺省值，同时决定汇率栏渲不渲染。外币采购单在没有
        // 汇率的情况下会被 resolvePoRate 直接拒绝，见 po-form.tsx。
        baseCurrency={context.baseCurrency}
        taxRates={taxRates.map((rate) => ({
          id: rate.id,
          name: (locale === 'zh' ? rate.nameZh : rate.nameEn) || rate.nameEn || rate.nameZh,
          rateBps: rate.rateBps,
        }))}
      />
    </>
  );
}
