import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listInvoices } from '@/server/repositories/invoices';
import { InvoiceList } from '@/components/invoices/invoice-list';

export default async function InvoicesListPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { orgSlug } = await params;
  // 表单保存成功后跳到这里并带上 ?saved=1。回执放在**落地页**而不是表单里：
  // 表单存完就 router.push 走了，在它上面渲染一句「已保存」用户根本来不及看见。
  // 这与登录页 ?checkEmail=1 是同一套做法。
  const { saved } = await searchParams;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const rows = await withTransaction(context.userId, async (tx) =>
    listInvoices(tx, context.organizationId),
  );

  return (
    <>
      <div className="page-header">
        <h1>{t.invoices.title}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/invoices/new`} className="primary-button">
            {t.invoices.newTitle}
          </Link>
        </div>
      </div>

      {saved === '1' ? (
        <p role="status" className="form-success">
          {t.invoices.saved}
        </p>
      ) : null}

      <InvoiceList
        orgSlug={orgSlug}
        rows={rows}
        locale={locale}
        emptyLabel={t.invoices.empty}
      />
    </>
  );
}
