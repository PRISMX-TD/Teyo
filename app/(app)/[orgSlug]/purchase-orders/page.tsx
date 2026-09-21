import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listPurchaseOrders } from '@/server/repositories/purchase_orders';
import { PoList } from '@/components/purchase-orders/po-list';

export default async function PurchaseOrdersListPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { orgSlug } = await params;
  // ?saved=1 是采购订单表单存完之后带过来的回执。理由见 invoices/page.tsx 同一处。
  const { saved } = await searchParams;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const purchaseOrders = await withTransaction(context.userId, async (tx) =>
    listPurchaseOrders(tx, context.organizationId),
  );

  return (
    <>
      <div className="page-header">
        <h1>{t.purchaseOrders.title}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/purchase-orders/new`} className="primary-button">
            {t.purchaseOrders.newTitle}
          </Link>
        </div>
      </div>

      {saved === '1' ? (
        <p role="status" className="form-success">
          {t.purchaseOrders.saved}
        </p>
      ) : null}

      <PoList
        orgSlug={orgSlug}
        locale={locale}
        purchaseOrders={purchaseOrders}
      />
    </>
  );
}
