import { PaymentForm } from '@/components/payments/payment-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listOutstandingDocuments } from '@/server/repositories/payments';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewPaymentPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  /**
   * 未结的发票与账单**必须**在这里查出来传给表单。
   *
   * 此前这个页面渲染 `<PaymentForm … />` 时没有传 outstandingInvoices /
   * outstandingBills，于是用户永远勾不到任何单据。
   *
   * 清单走 listOutstandingDocuments：它排除草稿（未过账，核销它等于凭空贷
   * 一笔应收），余额也扣掉了已签发的贷项通知单——原来这里自己用
   * listInvoices + sumSettledByDocument 拼，这两条都漏了。
   */
  const { contacts, outstandingInvoices, outstandingBills } = await withTransaction(
    context.userId,
    async (tx) => {
      const contactRows = await tx`
        select id, name
        from contacts
        where organization_id = ${context.organizationId}
          and is_active = true
        order by name
      ` as { id: string; name: string }[];

      const documents = await listOutstandingDocuments(tx, context.organizationId);

      return {
        contacts: contactRows,
        // 表单要的是「总额 + 已付」，这里把已付写成 total − remaining，
        // 余额的口径因此只有 listOutstandingDocuments 一处。
        outstandingInvoices: documents
          .filter((doc) => doc.kind === 'invoice')
          .map((doc) => ({
            id: doc.id,
            invoiceNumber: doc.number,
            customerName: doc.contactName,
            contactId: doc.contactId,
            totalMinor: doc.totalMinor,
            paidMinor: doc.totalMinor - doc.remainingMinor,
            currency: doc.currency,
          })),
        outstandingBills: documents
          .filter((doc) => doc.kind === 'bill')
          .map((doc) => ({
            id: doc.id,
            billNumber: doc.number,
            vendorName: doc.contactName,
            contactId: doc.contactId,
            totalMinor: doc.totalMinor,
            paidMinor: doc.totalMinor - doc.remainingMinor,
            currency: doc.currency,
          })),
      };
    },
  );

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
        baseCurrency={context.baseCurrency}
        outstandingInvoices={outstandingInvoices}
        outstandingBills={outstandingBills}
      />
    </>
  );
}
