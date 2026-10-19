import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';
import {
  listOpenPrepayments,
  listOutstandingDocuments,
  listPayments,
} from '@/server/repositories/payments';
import { listContacts } from '@/server/repositories/contacts';
import { PaymentList } from '@/components/payments/payment-list';
import type { OutstandingDocumentView } from '@/components/payments/prepayment-apply-dialog';

export default async function PaymentsListPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePagePermission(orgSlug, 'transaction:read');
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

      // 与 payments/new 同一份清单（排除草稿、扣掉贷项通知单），见
      // listOutstandingDocuments 的注释。
      const outstandingDocuments: OutstandingDocumentView[] = (
        await listOutstandingDocuments(tx, context.organizationId)
      ).map((doc) => ({
        id: doc.id,
        kind: doc.kind,
        number: doc.number,
        contactId: doc.contactId,
        currency: doc.currency,
        remainingMinor: doc.remainingMinor,
      }));

      return { openPrepayments, outstandingDocuments };
    }),
  ]);

  // 记录 / 核销 / 作废收付款都要 transaction:create；viewer 只读。
  const canWrite = can(context.role, 'transaction:create');

  return (
    <>
      <div className="page-header">
        <h1>{t.payments.title}</h1>
        {canWrite ? (
          <div className="page-header-actions">
            <Link href={`/${orgSlug}/payments/new`} className="primary-button">
              {t.payments.newTitle}
            </Link>
          </div>
        ) : null}
      </div>

      <PaymentList
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        payments={payments}
        contacts={contacts}
        openPrepayments={prepaymentData.openPrepayments}
        outstandingDocuments={prepaymentData.outstandingDocuments}
        canWrite={canWrite}
      />
    </>
  );
}
