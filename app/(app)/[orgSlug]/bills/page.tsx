import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listBills } from '@/server/repositories/bills';
import { BillList } from '@/components/bills/bill-list';

export default async function BillsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { orgSlug } = await params;
  // ?saved=1 是账单表单存完之后带过来的回执。理由见 invoices/page.tsx 同一处。
  const { saved } = await searchParams;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const rows = await withTransaction(context.userId, async (tx) =>
    listBills(tx, context.organizationId),
  );

  return (
    <>
      <div className="page-header">
        <h1>{t.bills.title}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/bills/new`} className="primary-button">
            {t.bills.newTitle}
          </Link>
        </div>
      </div>

      {saved === '1' ? (
        <p role="status" className="form-success">
          {t.bills.saved}
        </p>
      ) : null}

      <BillList
        orgSlug={orgSlug}
        rows={rows}
        locale={locale}
        emptyLabel={t.bills.empty}
      />
    </>
  );
}
