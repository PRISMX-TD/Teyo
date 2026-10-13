import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BillForm } from '@/components/bills/bill-form';
import { AttachmentPanel } from '@/components/transaction/attachment-panel';
import { getMessages, interpolate } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';
import { getBill } from '@/server/repositories/bills';
import { listAttachments } from '@/server/repositories/attachments';
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

  const { bill, contacts, taxRates, attachments } = await withTransaction(context.userId, async (tx) => {
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
    // 查不到账单时 found 是 null，下面会 404；这时也就不必去取附件。
    const files = found
      ? await listAttachments(tx, context.organizationId, { type: 'bill', id: found.id })
      : [];
    return { bill: found, contacts: rows, taxRates: rates, attachments: files };
  });

  if (!bill) notFound();

  // updateBill 要 transaction:edit:any，这一页只要 transaction:read。
  const canEdit = can(context.role, 'transaction:edit:any');

  // 停用的供应商要补回下拉框，理由见发票那一侧的同一段注释。
  const contactOptions = contacts.some((c) => c.id === bill.contactId)
    ? contacts
    : [{ id: bill.contactId, name: bill.contactName }, ...contacts];

  return (
    <>
      <div className="page-header">
        <h1>{interpolate(t.bills.editTitle, { number: bill.billNumber ?? '—' })}</h1>
        <div className="page-header-actions">
          {bill.purchaseOrderId ? (
            <Link
              href={`/${orgSlug}/purchase-orders/${bill.purchaseOrderId}`}
              className="text-button"
            >
              {interpolate(t.bills.fromPurchaseOrder, {
                number: bill.purchaseOrderNumber ?? '—',
              })}
            </Link>
          ) : null}
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
        readOnly={!canEdit}
      />

      {/*
        供应商寄来的账单原件。挂在账单上而不是它生成的那笔分录上：草稿账单
        还没有分录，已入账的账单改一次就重过一次账（见 0035 迁移）。
        改它的门与改账单本身相同；作废的账单只能看，不能再增删。
      */}
      <AttachmentPanel
        orgSlug={orgSlug}
        owner={{ type: 'bill', id: bill.id }}
        attachments={attachments.map((file) => ({
          id: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }))}
        t={t}
        readOnly={!canEdit || bill.status === 'voided'}
        labels={{
          title: t.bills.attachments,
          empty: t.bills.noAttachments,
          add: t.bills.addAttachment,
        }}
      />
    </>
  );
}
