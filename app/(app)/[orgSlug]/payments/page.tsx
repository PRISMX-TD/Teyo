import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listPayments } from '@/server/repositories/payments';
import { listContacts } from '@/server/repositories/contacts';
import { PaymentList } from '@/components/payments/payment-list';

export default async function PaymentsListPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const [payments, contacts] = await Promise.all([
    withTransaction(context.userId, async (tx) =>
      listPayments(tx, context.organizationId),
    ),
    withTransaction(context.userId, async (tx) => {
      const rows = await listContacts(tx, context.organizationId);
      return rows.map((c) => ({ id: c.id, name: c.name }));
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
      />
    </>
  );
}
