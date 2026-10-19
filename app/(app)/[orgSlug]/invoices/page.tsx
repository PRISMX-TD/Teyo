import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { todayInOrg, requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
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
  const context = await requirePagePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const rows = await withTransaction(context.userId, async (tx) =>
    listInvoices(tx, context.organizationId),
  );

  // 页面只要 transaction:read（viewer 也进得来），而新建/开具要
  // transaction:create、编辑/作废要 transaction:edit:any。按钮照角色画，
  // 否则 viewer 点下去才吃一句权限报错。
  const canCreate = can(context.role, 'transaction:create');
  const canEdit = can(context.role, 'transaction:edit:any');

  return (
    <>
      <div className="page-header">
        <h1>{t.invoices.title}</h1>
        {canCreate ? (
          <div className="page-header-actions">
            <Link href={`/${orgSlug}/invoices/new`} className="primary-button">
              {t.invoices.newTitle}
            </Link>
          </div>
        ) : null}
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
        canIssue={canCreate}
        canEdit={canEdit}
        today={todayInOrg(context)}
      />
    </>
  );
}
