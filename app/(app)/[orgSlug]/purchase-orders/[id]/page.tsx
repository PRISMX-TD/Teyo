import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/uuid';
import { PoForm } from '@/components/purchase-orders/po-form';
import { PoStatusActions } from '@/components/purchase-orders/po-status-actions';
import { DocumentLifecycle } from '@/components/invoices/document-lifecycle';
import { BackLink } from '@/components/ui/back-link';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { currencyExponent, formatMinorToDecimal, sumMinor } from '@/server/domain/money';
import { formatScaledRate } from '@/server/domain/exchange-rate';
import { getUserLocale } from '@/server/repositories/organizations';
import { getPurchaseOrder, isPoBillable } from '@/server/repositories/purchase-orders';
import { findActiveBillForPurchaseOrder } from '@/server/repositories/bills';
import { formatScaledQuantity } from '@/server/repositories/inventory';
import { listTaxRates } from '@/server/repositories/tax';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/**
 * 定标数量还原出来的字符串固定四位小数（6.0000）。只读显示时去掉尾零：
 * 「6」「2.5」才是人写下的数量。
 */
function trimQuantity(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

/** 把「编辑采购订单 {number}」拆开，单号单独包一层，不在连字符处折行。 */
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
 * 一张采购订单的详情/编辑页。
 *
 * 这个路由此前**不存在**，而 po-list.tsx 上那段注释正说明了后果：单号
 * 曾经链到这里、拿到 404，于是链接被撤掉，采购单从此没有任何详情页；
 * updatePurchaseOrderAction 也因此在 app/ 与 components/ 下零引用。结构
 * 照 invoices/[id] 与 bills/[id] 写，它们解决的是同一个问题。
 *
 * 只有草稿能改。updatePurchaseOrderAction 在服务端也拒绝非草稿，这里只是
 * 不把一张必然被拒的表单画出来：draft 之后的每一个状态都意味着这份单子
 * 已经发出去了，事后改掉自己这一份，只会让买卖双方各拿着一张不一样的采购单。
 */
export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  // 不是 uuid 的 id 进 SQL 是类型错误、整页 500；与「查不到」一样给 404。
  if (!isUuid(id)) notFound();
  const context = await requirePagePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { po, vendors, taxRates, activeBill } = await withTransaction(context.userId, async (tx) => {
    const found = await getPurchaseOrder(tx, context.organizationId, id);
    if (!found) return { po: null, vendors: [], taxRates: [], activeBill: null };

    // `or id = ...`：这张单的供应商可能已经被停用，那样它就不在下拉框里，
    // 保存之后供应商会静默换成列表里的第一个。与发票页那一段同一个理由。
    const vendorRows = (await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('vendor', 'both')
        and (is_active = true or id = ${found.contactId})
      order by name
    `) as { id: string; name: string }[];

    const rates = await listTaxRates(tx, context.organizationId);
    // 转出来、仍然有效的那张账单（作废的不算，见 findActiveBillForPurchaseOrder）。
    const bill = await findActiveBillForPurchaseOrder(tx, context.organizationId, found.id);
    return { po: found, vendors: vendorRows, taxRates: rates, activeBill: bill };
  });

  // getPurchaseOrder 已经按 organization_id 过滤过，「查不到」与「不是你的」
  // 在这里是同一件事，两者都只该得到 404。
  if (!po) notFound();

  const exponent = currencyExponent(po.currency);
  const documentTotalMinor = sumMinor(po.items.map((item) => item.amountMinor));
  const isVoided = po.status === 'voided';
  const isDraft = po.status === 'draft';
  // updatePurchaseOrderAction 要的是 transaction:edit:any（owner/admin），
  // 而这一页只要 transaction:read。不在这里判一次，记账员会看到一张填得动
  // 却必然保存失败的表单。
  const mayEdit = can(context.role, 'transaction:edit:any');

  // 「转为账单」与 createBill 同一道权限（transaction:create，记账员也有），
  // 状态判断与服务端共用 isPoBillable。
  const mayConvert =
    can(context.role, 'transaction:create') && isPoBillable(po.status) && activeBill === null;

  const statusNotice = isVoided
    ? t.purchaseOrders.voidedNotice
    : !isDraft
      ? t.purchaseOrders.lockedNotice
      : mayEdit
        ? t.purchaseOrders.draftEditableNotice
        : t.common.noEditPermission;

  return (
    <>
      <BackLink href={`/${orgSlug}/purchase-orders`}>{t.purchaseOrders.title}</BackLink>
      <div className="page-header">
        {/* 只有能改的草稿才叫「编辑」；发出去之后这一页是查看，不是编辑。 */}
        <h1>
          {titleWithNumber(
            isDraft && mayEdit ? t.purchaseOrders.editTitle : t.purchaseOrders.viewTitle,
            po.poNumber,
          )}
        </h1>
        {mayConvert ? (
          <div className="page-header-actions">
            {/* 跳去一张按这张采购单预填的新账单表单，而不是一键生成：账单的
                到期日、实际金额要照供应商开来的那张填。见 CreateBillInput.purchaseOrderId。 */}
            <Link href={`/${orgSlug}/bills/new?fromPo=${po.id}`} className="primary-button">
              {t.purchaseOrders.convertToBill}
            </Link>
          </div>
        ) : null}
      </div>

      <DocumentLifecycle
        caption={t.purchaseOrders.lifecycle}
        steps={[
          { value: 'draft', label: t.purchaseOrders.statusDraft },
          { value: 'sent', label: t.purchaseOrders.statusSent },
          { value: 'received', label: t.purchaseOrders.statusReceived },
          { value: 'billed', label: t.purchaseOrders.statusBilled },
          { value: 'closed', label: t.purchaseOrders.statusClosed },
        ]}
        current={po.status}
        voided={isVoided}
        voidedLabel={t.purchaseOrders.statusVoided}
        notice={statusNotice}
      />

      {isDraft && mayEdit ? (
        <PoForm
          orgSlug={orgSlug}
          locale={locale}
          vendors={vendors}
          currencies={[...SUPPORTED_CURRENCIES]}
          baseCurrency={context.baseCurrency}
          taxRates={taxRates.map((rate) => ({
            id: rate.id,
            name: (locale === 'zh' ? rate.nameZh : rate.nameEn) || rate.nameEn || rate.nameZh,
            rateBps: rate.rateBps,
          }))}
          purchaseOrder={{
            id: po.id,
            poNumber: po.poNumber,
            contactId: po.contactId,
            issueDate: po.issueDate,
            expectedDate: po.expectedDate,
            currency: po.currency,
            // 三个定标整数各走各自那一份唯一实现还原：数量 10^4、
            // 金额按币种的小数位、汇率 10^8。客户端不再自己算一遍。
            exchangeRate: formatScaledRate(po.exchangeRate),
            notes: po.notes,
            items: po.items.map((item) => ({
              description: item.description,
              quantity: trimQuantity(formatScaledQuantity(item.quantityScaled)),
              unitPrice: formatMinorToDecimal(item.unitPriceMinor, exponent),
              taxRateId: item.taxRateId ?? '',
            })),
          }}
        />
      ) : (
        <article className="record-detail">
          <dl>
            <dt>{t.purchaseOrders.poNumber}</dt>
            <dd className="mono">{po.poNumber}</dd>
            <dt>{t.purchaseOrders.vendor}</dt>
            <dd>{po.contactName ?? '—'}</dd>
            <dt>{t.purchaseOrders.issueDate}</dt>
            <dd className="mono">{po.issueDate}</dd>
            <dt>{t.purchaseOrders.expectedDate}</dt>
            <dd className="mono">{po.expectedDate ?? '—'}</dd>
            <dt>{t.purchaseOrders.currency}</dt>
            <dd className="mono">{po.currency}</dd>
            <dt>{t.purchaseOrders.total}</dt>
            <dd className="mono amount">{formatMoney(documentTotalMinor, po.currency, locale)}</dd>
            {/* base_total_minor 是**本位币**（列名里的 base 就是这个意思，
                见 server/actions/purchase-orders.ts 的 totalsFor）。用单据
                自己的币种去格式化它，正是列表页上还留着的那个缺陷。
                本位币单据两行是同一个数，只留合计；外币单据才折算，且用常规字号，
                合计仍是唯一的大数字。 */}
            {po.currency !== context.baseCurrency ? (
              <>
                <dt>{t.purchaseOrders.baseTotal}</dt>
                <dd className="mono">{formatMoney(po.baseTotalMinor, context.baseCurrency, locale)}</dd>
              </>
            ) : null}
            {/* 转出来的那张账单。原来是页头动作区里的一个文字链接，和主按钮挤在一行。 */}
            {activeBill ? (
              <>
                <dt>{t.purchaseOrders.linkedBill}</dt>
                <dd>
                  <Link href={`/${orgSlug}/bills/${activeBill.id}`} className="mono">
                    {activeBill.billNumber ?? '—'}
                  </Link>
                </dd>
              </>
            ) : null}
            <dt>{t.purchaseOrders.notes}</dt>
            <dd>{po.notes || '—'}</dd>
          </dl>

          <h2>{t.purchaseOrders.items}</h2>
          {/* po-items-table：手机上每行折成「描述 / 数量 × 单价 … 金额」两行，
              不再让金额列滑到卡片外面。 */}
          <div className="table-scroll">
            <table className="report-table po-items-table">
              <thead>
                <tr>
                  <th>{t.purchaseOrders.description}</th>
                  <th className="numeric">{t.purchaseOrders.quantity}</th>
                  <th className="numeric">{t.purchaseOrders.unitPrice}</th>
                  <th className="numeric">{t.purchaseOrders.amount}</th>
                </tr>
              </thead>
              <tbody>
                {po.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.description}</td>
                    <td className="numeric mono">
                      {trimQuantity(formatScaledQuantity(item.quantityScaled))}
                    </td>
                    <td className="numeric mono">
                      {formatMoney(item.unitPriceMinor, po.currency, locale)}
                    </td>
                    <td className="numeric mono">
                      {formatMoney(item.amountMinor, po.currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}

      {/* 状态流转与列表上同一组按钮；放在页面最后，像 iOS 详情页底部的操作行。 */}
      {mayEdit ? (
        <PoStatusActions
          orgSlug={orgSlug}
          locale={locale}
          po={{ id: po.id, poNumber: po.poNumber, status: po.status }}
          variant="rows"
        />
      ) : null}
    </>
  );
}
