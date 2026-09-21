import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PoForm } from '@/components/purchase-orders/po-form';
import { DocumentLifecycle } from '@/components/invoices/document-lifecycle';
import { getMessages, interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { currencyExponent, formatMinorToDecimal, sumMinor } from '@/server/domain/money';
import { formatScaledRate } from '@/server/domain/exchange-rate';
import { getUserLocale } from '@/server/repositories/organizations';
import { getPurchaseOrder } from '@/server/repositories/purchase_orders';
import { formatScaledQuantity } from '@/server/repositories/inventory';
import { listTaxRates } from '@/server/repositories/tax';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/**
 * 一张采购订单的详情/编辑页。
 *
 * 这个路由此前**不存在**，而 po-list.tsx 上那段注释正说明了后果：单号
 * 曾经链到这里、拿到 404，于是链接被撤掉，采购单从此没有任何详情页；
 * updatePurchaseOrderAction 也因此在 app/ 与 components/ 下零引用。结构
 * 照 invoices/[id] 与 bills/[id] 写，它们解决的是同一个问题。
 *
 * 只有草稿能改。这一条不是服务端给的——updatePurchaseOrderAction 本身不
 * 看状态，它信任调用方——所以判断落在这里，依据是 setPoStatusAction 认的
 * 那个状态枚举：draft 之后的每一个状态都意味着这份单子已经发出去了，
 * 事后改掉自己这一份，只会让买卖双方各拿着一张不一样的采购单。
 */
export default async function PurchaseOrderDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { po, vendors, taxRates } = await withTransaction(context.userId, async (tx) => {
    const found = await getPurchaseOrder(tx, context.organizationId, id);
    if (!found) return { po: null, vendors: [], taxRates: [] };

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
    return { po: found, vendors: vendorRows, taxRates: rates };
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

  const statusNotice = isVoided
    ? t.purchaseOrders.voidedNotice
    : !isDraft
      ? t.purchaseOrders.lockedNotice
      : mayEdit
        ? t.purchaseOrders.draftNotice
        : t.common.noEditPermission;

  return (
    <>
      <div className="page-header">
        <h1>{interpolate(t.purchaseOrders.editTitle, { number: po.poNumber })}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/purchase-orders`} className="text-button">
            {t.purchaseOrders.backToList}
          </Link>
        </div>
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
              quantity: formatScaledQuantity(item.quantityScaled),
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
                见 server/actions/purchase_orders.ts 的 totalsFor）。用单据
                自己的币种去格式化它，正是列表页上还留着的那个缺陷。 */}
            <dt>{t.purchaseOrders.baseTotal}</dt>
            <dd className="mono amount">
              {formatMoney(po.baseTotalMinor, context.baseCurrency, locale)}
            </dd>
            <dt>{t.purchaseOrders.notes}</dt>
            <dd>{po.notes || '—'}</dd>
          </dl>

          <h2>{t.purchaseOrders.items}</h2>
          <table className="report-table">
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
                  <td className="numeric mono">{formatScaledQuantity(item.quantityScaled)}</td>
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
        </article>
      )}
    </>
  );
}
