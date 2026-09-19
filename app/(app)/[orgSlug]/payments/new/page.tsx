import { PaymentForm } from '@/components/payments/payment-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listInvoices } from '@/server/repositories/invoices';
import { listBills } from '@/server/repositories/bills';
import { sumSettledByDocument } from '@/server/repositories/payments';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/** 不能再被核销的状态。作废的不算数，已收讫的没有余额。 */
const CLOSED_STATUSES = new Set(['voided', 'paid']);

export default async function NewPaymentPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  /**
   * 未结的发票与账单**必须**在这里查出来传给表单。
   *
   * 此前这个页面渲染 `<PaymentForm … />` 时没有传 outstandingInvoices /
   * outstandingBills，而那两个 prop 是可选的。后果不是「少一个板块」：
   * 表单只有在这两个数组非空时才渲染勾选区，于是用户永远勾不到任何单据，
   * 提交时送出去的是 `{ invoiceId: null, billId: null }`，而 payment_items
   * 上的 `payment_items_one_target` CHECK 要求两列恰好一个非空——
   * **今天这个页面记不出任何一笔收付款**，每一次提交都撞一条裸的 Postgres
   * 约束报错。
   *
   * 已核销金额走 sumSettledByDocument（作废的收付款不计入），而不是各自
   * 再写一遍 sum：那正是「同一个数有两处实现」的起点。
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

      const [invoices, bills] = await Promise.all([
        listInvoices(tx, context.organizationId),
        listBills(tx, context.organizationId),
      ]);

      const openInvoices = invoices.filter(
        (row) => !CLOSED_STATUSES.has(row.status) && row.voidedAt === null,
      );
      const openBills = bills.filter(
        (row) => !CLOSED_STATUSES.has(row.status) && row.voidedAt === null,
      );

      const [invoicePaid, billPaid] = await Promise.all([
        sumSettledByDocument(
          tx,
          context.organizationId,
          'invoice',
          openInvoices.map((row) => row.id),
        ),
        sumSettledByDocument(
          tx,
          context.organizationId,
          'bill',
          openBills.map((row) => row.id),
        ),
      ]);

      return {
        contacts: contactRows,
        outstandingInvoices: openInvoices.map((row) => ({
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          customerName: row.contactName,
          // contactId 一起传：表单要按选中的往来对象过滤，否则会把 A 客户的
          // 发票列在 B 客户的收款下面。服务端今天不校验这一条（它只查单据
          // 属不属于本公司），所以这里是唯一的一道。
          contactId: row.contactId,
          totalMinor: row.totalMinor,
          paidMinor: invoicePaid.get(row.id) ?? 0n,
          currency: row.currency,
        })),
        outstandingBills: openBills.map((row) => ({
          id: row.id,
          billNumber: row.billNumber ?? '—',
          vendorName: row.contactName,
          contactId: row.contactId,
          totalMinor: row.totalMinor,
          paidMinor: billPaid.get(row.id) ?? 0n,
          currency: row.currency,
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
