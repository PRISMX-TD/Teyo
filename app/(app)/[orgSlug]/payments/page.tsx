import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listOpenPrepayments, listPayments, sumSettledByDocument } from '@/server/repositories/payments';
import { listContacts } from '@/server/repositories/contacts';
import { listInvoices } from '@/server/repositories/invoices';
import { listBills } from '@/server/repositories/bills';
import { PaymentList } from '@/components/payments/payment-list';
import type { OutstandingDocumentView } from '@/components/payments/prepayment-apply-dialog';

/** 不能再被核销的状态。作废的不算数，已收讫的没有余额。与 payments/new 同一份判断。 */
const CLOSED_STATUSES = new Set(['voided', 'paid']);

export default async function PaymentsListPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const [payments, contacts, prepaymentData] = await Promise.all([
    withTransaction(context.userId, async (tx) =>
      listPayments(tx, context.organizationId),
    ),
    withTransaction(context.userId, async (tx) => {
      const rows = await listContacts(tx, context.organizationId);
      return rows.map((c) => ({ id: c.id, name: c.name }));
    }),
    /**
     * 挂账的款项，以及它们能核销到哪些单据上。
     *
     * 两件事一起查而不是分两个 withTransaction：它们在同一个快照里才对得上
     * ——先查完预收余额、再查单据时如果有人刚核销了一笔，界面上会出现一笔
     * 余额与一张已经被冲掉的发票，用户点下去只会看到一句服务端的报错。
     *
     * 未结单据这里**不**按往来对象过滤：过滤在对话框里做（按被选中的那笔
     * 预收款的往来对象与币种）。在这里过滤要先知道选的是哪一笔，而那是
     * 客户端才有的信息。
     */
    withTransaction(context.userId, async (tx) => {
      const openPrepayments = await listOpenPrepayments(tx, context.organizationId);
      if (openPrepayments.length === 0) {
        // 没有挂账的钱就不必把全部未结单据读出来——这个页面每次打开都要跑。
        return { openPrepayments, outstandingDocuments: [] as OutstandingDocumentView[] };
      }

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

      // 已核销金额走 sumSettledByDocument（作废的收付款不计入），而不是各自
      // 再写一遍 sum：那正是「同一个数有两处实现」的起点。
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

      const outstandingDocuments: OutstandingDocumentView[] = [
        ...openInvoices.map((row) => ({
          id: row.id,
          kind: 'invoice' as const,
          number: row.invoiceNumber,
          contactId: row.contactId,
          currency: row.currency,
          remainingMinor: row.totalMinor - (invoicePaid.get(row.id) ?? 0n),
        })),
        ...openBills.map((row) => ({
          id: row.id,
          kind: 'bill' as const,
          number: row.billNumber ?? '—',
          contactId: row.contactId,
          currency: row.currency,
          remainingMinor: row.totalMinor - (billPaid.get(row.id) ?? 0n),
        })),
      ].filter((doc) => doc.remainingMinor > 0n);

      return { openPrepayments, outstandingDocuments };
    }),
  ]);

  return (
    <>
      <div className="page-header">
        <h1>{t.payments.title}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/payments/new`} className="primary-button">
            {t.payments.newTitle}
          </Link>
        </div>
      </div>

      <PaymentList
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        payments={payments}
        contacts={contacts}
        openPrepayments={prepaymentData.openPrepayments}
        outstandingDocuments={prepaymentData.outstandingDocuments}
      />
    </>
  );
}
