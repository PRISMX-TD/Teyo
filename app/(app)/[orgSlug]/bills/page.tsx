import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listBills } from '@/server/repositories/bills';
import { BillList } from '@/components/bills/bill-list';

export default async function BillsListPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const rows = await withTransaction(context.userId, async (tx) =>
    listBills(tx, context.organizationId),
  );

  return (
    <>
      <h1>{t.bills.title}</h1>
      <Link href={`/${orgSlug}/bills/new`} className="primary-button">
        {t.bills.newTitle}
      </Link>

      <BillList
        orgSlug={orgSlug}
        rows={rows}
        locale={locale}
        emptyLabel={t.bills.empty}
      />
    </>
  );
}
