import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InvoiceForm } from '@/components/invoices/invoice-form';
import { getMessages, interpolate } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';
import { getInvoice } from '@/server/repositories/invoices';
import { hasBalanceToSettle, sumDeductedByDocument } from '@/server/repositories/payments';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/**
 * 一张发票的详情/编辑页。
 *
 * 这个路由此前**不存在**：invoice-list.tsx 上每一行的发票号都链到
 * `/{orgSlug}/invoices/{id}`，而 app/(app)/[orgSlug]/invoices/ 下只有
 * page.tsx 与 new/ 两项——点发票号得到的是 404。同一个洞在 bills 与
 * purchase-orders 上也有（后者不在本轮范围）。
 *
 * 加它不只是补一个死链：updateInvoice 是这一轮新接进记账边界的三个动作
 * 之一（已过账的发票改了金额会走 repostJournal 重建分录），而在此之前
 * 界面上没有任何地方调得到它。
 */
export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { invoice, contacts, deductedMinor } = await withTransaction(context.userId, async (tx) => {
    const found = await getInvoice(tx, context.organizationId, id);
    const deducted = found
      ? ((await sumDeductedByDocument(tx, context.organizationId, 'invoice', [found.id])).get(
          found.id,
        ) ?? 0n)
      : 0n;
    const rows = await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('customer', 'both')
        and is_active = true
      order by name
    ` as { id: string; name: string }[];
    return { invoice: found, contacts: rows, deductedMinor: deducted };
  });

  // getInvoice 已经按 organization_id 过滤过，所以「查不到」与「不是你的」
  // 在这里是同一件事——两者都只该得到 404，回一句「这张发票属于别家公司」
  // 等于确认了那个 id 在别处存在。
  if (!invoice) notFound();

  // 这张发票的客户可能已经被停用，那样它就不在上面的列表里，下拉框会落到
  // 第一个联系人上——用户只是想改一下备注，保存之后客户换了人。把它补回去。
  const contactOptions = contacts.some((c) => c.id === invoice.contactId)
    ? contacts
    : [{ id: invoice.contactId, name: invoice.contactName }, ...contacts];

  // 这一页只要 transaction:read，而 updateInvoice 要 transaction:edit:any
  // （owner/admin）。不在这里判，viewer 与记账员会看到一张填得动却必然
  // 保存失败的表单。
  const mayEdit = can(context.role, 'transaction:edit:any');

  // 「记录收款」：发票还欠着钱、而这个人记得了收款（createPayment 要
  // transaction:create）才出现。点进去，收付款页按这张发票填好客户、币种
  // 与金额。
  const mayRecordPayment =
    can(context.role, 'transaction:create') && hasBalanceToSettle(invoice, deductedMinor);

  return (
    <>
      <div className="page-header">
        <h1>{interpolate(t.invoices.editTitle, { number: invoice.invoiceNumber })}</h1>
        <div className="page-header-actions">
          {mayRecordPayment ? (
            <Link
              href={`/${orgSlug}/payments/new?invoice=${invoice.id}`}
              className="primary-button"
            >
              {t.invoices.recordPayment}
            </Link>
          ) : null}
          {/* 打印页此前只能从列表进，详情页上没有入口，而打印页的「返回」
              却指回这里。 */}
          <Link href={`/${orgSlug}/invoices/${invoice.id}/print`} className="text-button">
            {t.invoicePdf.print}
          </Link>
          <Link href={`/${orgSlug}/invoices`} className="text-button">
            {t.invoices.backToList}
          </Link>
        </div>
      </div>

      {mayEdit ? null : <p className="hint">{t.common.noEditPermission}</p>}

      <InvoiceForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={contactOptions}
        currencies={[...SUPPORTED_CURRENCIES]}
        baseCurrency={context.baseCurrency}
        invoice={invoice}
        readOnly={!mayEdit}
      />
    </>
  );
}
