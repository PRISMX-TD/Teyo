import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BillForm } from '@/components/bills/bill-form';
import { AttachmentPanel } from '@/components/transaction/attachment-panel';
import { BackLink } from '@/components/ui/back-link';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission, todayInOrg } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';
import { getBill } from '@/server/repositories/bills';
import { hasBalanceToSettle, sumDeductedByDocument } from '@/server/repositories/payments';
import { listAttachments } from '@/server/repositories/attachments';
import { listTaxRates } from '@/server/repositories/tax';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/** 把「编辑账单 {number}」拆开，单号单独包一层，不在连字符处折行。 */
function titleWithNumber(template: string, number: string) {
  const [before, after = ''] = template.split('{number}');
  return (
    <>
      {before}
      <span className="doc-no">{number}</span>
      {after}
    </>
  );
}

/**
 * 一张账单的详情/编辑页。与发票那一侧对称，存在的理由也相同：
 * bill-list.tsx 一直链到这个路由，而这个路由此前不存在（404）；
 * updateBill / receiveBill 也没有任何界面入口。
 */
export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { bill, contacts, taxRates, attachments, deductedMinor } = await withTransaction(context.userId, async (tx) => {
    const found = await getBill(tx, context.organizationId, id);
    const deducted = found
      ? ((await sumDeductedByDocument(tx, context.organizationId, 'bill', [found.id])).get(
          found.id,
        ) ?? 0n)
      : 0n;
    const rows = await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('vendor', 'both')
        and is_active = true
      order by name
    ` as { id: string; name: string }[];
    const rates = await listTaxRates(tx, context.organizationId);
    // 查不到账单时 found 是 null，下面会 404；这时也就不必去取附件。
    const files = found
      ? await listAttachments(tx, context.organizationId, { type: 'bill', id: found.id })
      : [];
    return {
      bill: found,
      contacts: rows,
      taxRates: rates,
      attachments: files,
      deductedMinor: deducted,
    };
  });

  if (!bill) notFound();

  // updateBill 要 transaction:edit:any，这一页只要 transaction:read。
  const canEdit = can(context.role, 'transaction:edit:any');
  // 与发票页的「记录收款」对称，见那里的注释。
  const mayRecordPayment =
    can(context.role, 'transaction:create') && hasBalanceToSettle(bill, deductedMinor);

  // 停用的供应商要补回下拉框，理由见发票那一侧的同一段注释。
  const contactOptions = contacts.some((c) => c.id === bill.contactId)
    ? contacts
    : [{ id: bill.contactId, name: bill.contactName }, ...contacts];

  const isVoided = bill.status === 'voided' || bill.voidedAt !== null;
  const isDraft = bill.status === 'draft';
  // 已付讫、已作废、或者没有编辑权限的账单，这一页是查看，不是编辑。
  const isViewOnly = !canEdit || isVoided || bill.status === 'paid';
  const balanceMinor = bill.totalMinor - deductedMinor;
  // 逾期从不落库（没有任何地方把 status 写成 overdue），按公司时区的
  // 「今天」现推：已入账、还欠着钱、过了到期日。
  const overdue =
    !isVoided && !isDraft && balanceMinor > 0n && bill.dueDate < todayInOrg(context);
  // 草稿与作废的账单没有「已付 / 待付」可言，只列合计。
  const showSettlement = !isVoided && !isDraft;

  const summary = (
    <article
      className={`record-detail record-detail--inline doc-summary bill-summary${isVoided ? ' voided' : ''}`}
    >
      <dl>
        <dt>{t.bills.total}</dt>
        <dd className={showSettlement && balanceMinor > 0n ? 'mono' : 'mono amount'}>
          {formatMoney(bill.totalMinor, bill.currency, locale)}
        </dd>
        {showSettlement ? (
          <>
            <dt>{t.bills.paidAmount}</dt>
            <dd className="mono">{formatMoney(deductedMinor, bill.currency, locale)}</dd>
            {balanceMinor > 0n ? (
              <>
                <dt>{t.bills.balanceDue}</dt>
                <dd className="mono amount">{formatMoney(balanceMinor, bill.currency, locale)}</dd>
              </>
            ) : null}
          </>
        ) : null}
        {/* 逾期徽章跟在标签后面（同发票页）：放在值那一格会把整列值撑宽，
            320 宽时每一行的标签都被挤成两行。 */}
        <dt>
          {t.bills.dueDate}
          {overdue ? <span className="badge badge-danger">{t.bills.statusOverdue}</span> : null}
        </dt>
        <dd className="mono">{bill.dueDate}</dd>
        {/* 从哪张采购订单转来。原来是页头动作区里的一个文字链接，和主按钮挤在一行。 */}
        {bill.purchaseOrderId ? (
          <>
            <dt>{t.bills.sourcePo}</dt>
            <dd>
              <Link href={`/${orgSlug}/purchase-orders/${bill.purchaseOrderId}`} className="mono">
                {bill.purchaseOrderNumber ?? '—'}
              </Link>
            </dd>
          </>
        ) : null}
      </dl>
    </article>
  );

  return (
    <>
      <BackLink href={`/${orgSlug}/bills`}>{t.bills.title}</BackLink>
      <div className="page-header">
        <h1>
          {titleWithNumber(isViewOnly ? t.bills.viewTitle : t.bills.editTitle, bill.billNumber ?? '—')}
        </h1>
        {mayRecordPayment ? (
          <div className="page-header-actions">
            <Link href={`/${orgSlug}/payments/new?bill=${bill.id}`} className="primary-button">
              {t.bills.recordPayment}
            </Link>
          </div>
        ) : null}
      </div>

      <BillForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={contactOptions}
        currencies={[...SUPPORTED_CURRENCIES]}
        baseCurrency={context.baseCurrency}
        taxRates={taxRates.map((rate) => ({
          id: rate.id,
          name: (locale === 'zh' ? rate.nameZh : rate.nameEn) || rate.nameEn || rate.nameZh,
          rateBps: rate.rateBps,
        }))}
        bill={bill}
        readOnly={!canEdit}
        summary={summary}
        overdue={overdue}
      />

      {/*
        供应商寄来的账单原件。挂在账单上而不是它生成的那笔分录上：草稿账单
        还没有分录，已入账的账单改一次就重过一次账（见 0035 迁移）。
        改它的门与改账单本身相同；作废的账单只能看，不能再增删。
      */}
      <AttachmentPanel
        orgSlug={orgSlug}
        owner={{ type: 'bill', id: bill.id }}
        attachments={attachments.map((file) => ({
          id: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }))}
        t={t}
        readOnly={!canEdit || isVoided}
        labels={{
          title: t.bills.attachments,
          empty: t.bills.noAttachments,
          add: t.bills.addAttachment,
        }}
      />
    </>
  );
}
