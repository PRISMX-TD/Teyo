import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BillForm } from '@/components/bills/bill-form';
import { getMessages, interpolate } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getBill } from '@/server/repositories/bills';
import { listTaxRates } from '@/server/repositories/tax';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/**
 * 一张账单的详情/编辑页。与发票那一侧对称，存在的理由也相同：
 * bill-list.tsx 一直链到这个路由，而这个路由此前不存在（404）；
 * updateBill / receiveBill 也没有任何界面入口。
 */
export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { bill, contacts, taxRates } = await withTransaction(context.userId, async (tx) => {
    const found = await getBill(tx, context.organizationId, id);
    const rows = await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('vendor', 'both')
        and is_active = true
      order by name
    ` as { id: string; name: string }[];
    const rates = await listTaxRates(tx, context.organizationId);
    return { bill: found, contacts: rows, taxRates: rates };
  });

  if (!bill) notFound();

  // 停用的供应商要补回下拉框，理由见发票那一侧的同一段注释。
  const contactOptions = contacts.some((c) => c.id === bill.contactId)
    ? contacts
    : [{ id: bill.contactId, name: bill.contactName }, ...contacts];

  return (
    <>
      <div className="page-header">
        <h1>{interpolate(t.bills.editTitle, { number: bill.billNumber ?? '—' })}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/bills`} className="text-button">
            {t.bills.backToList}
          </Link>
        </div>
      </div>

      <BillForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={contactOptions}
        currencies={[...SUPPORTED_CURRENCIES]}
        baseCurrency={context.baseCurrency}
        taxRates={taxRates.map((rate) => ({
          id: rate.id,
          name: (locale === 'zh' ? rate.nameZh : rate.nameEn) || rate.nameEn || rate.nameZh,
          rateBps: rate.rateBps,
        }))}
        bill={bill}
      />
    </>
  );
}
