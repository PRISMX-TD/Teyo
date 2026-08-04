import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listInvoices } from '@/server/repositories/invoices';
import { InvoiceList } from '@/components/invoices/invoice-list';

export default async function InvoicesListPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const rows = await withTransaction(context.userId, async (tx) =>
    listInvoices(tx, context.organizationId),
  );

  return (
    <>
      <h1>{t.invoices.title}</h1>
      <Link href={`/${orgSlug}/invoices/new`} className="primary-button">
        {t.invoices.newTitle}
      </Link>

      <InvoiceList
        orgSlug={orgSlug}
        rows={rows}
        locale={locale}
        emptyLabel={t.invoices.empty}
      />
    </>
  );
}
