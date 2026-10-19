import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/uuid';
import { InvoiceForm } from '@/components/invoices/invoice-form';
import { InvoiceVoidButton } from '@/components/invoices/invoice-actions';
import { HeaderIssueButton, HeaderIssueProvider } from '@/components/invoices/header-issue';
import { BackLink } from '@/components/ui/back-link';
import { Printer } from '@/components/ui/icons';
import { getMessages, interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { todayInOrg, requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';
import { getInvoice } from '@/server/repositories/invoices';
import { hasBalanceToSettle, sumDeductedByDocument } from '@/server/repositories/payments';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/** 两个 YYYY-MM-DD 之间差几天。按 UTC 日历日算，不经本地时区，跨夏令时也不差一天。 */
function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split('-').map(Number);
  const [ty, tm, td] = toISO.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

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
  // 不是 uuid 的 id 进 SQL 是类型错误、整页 500；与「查不到」一样给 404。
  if (!isUuid(id)) notFound();
  const context = await requirePagePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { invoice, contacts, deductedMinor } = await withTransaction(context.userId, async (tx) => {
    // 发票与客户列表互不依赖，一起发；已收要等发票。
    const [found, rows] = await Promise.all([
      getInvoice(tx, context.organizationId, id),
      tx`
        select id, name
        from contacts
        where organization_id = ${context.organizationId}
          and type in ('customer', 'both')
          and is_active = true
        order by name
      ` as Promise<{ id: string; name: string }[]>,
    ]);
    const deducted = found
      ? ((await sumDeductedByDocument(tx, context.organizationId, 'invoice', [found.id])).get(
          found.id,
        ) ?? 0n)
      : 0n;
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

  // InvoiceStatus 里没有 partially_paid（见 invoice-list.tsx 的注释），放宽成 string。
  const status: string = invoice.status;
  const isVoided = status === 'voided' || invoice.voidedAt !== null;
  // 下一步动作与列表卡片同一套条件：开具只给草稿（transaction:create），
  // 作废给 owner/admin（transaction:edit:any），已作废的什么都不给。
  const mayIssue = can(context.role, 'transaction:create') && status === 'draft' && !isVoided;
  const mayVoid = mayEdit && !isVoided;

  // 合计 / 已收 / 未收。全程 bigint，在服务端算好：前端不做金额运算。
  // 已冲掉的超过总额只可能是数据不一致，未收按 0 显示，与打印页同一个口径。
  const balanceMinor =
    invoice.totalMinor > deductedMinor ? invoice.totalMinor - deductedMinor : 0n;
  const showSettlement = !isVoided && status !== 'draft';
  // 逾期没有任何地方会写进 status（枚举里有，服务端从不设），只能在这里按
  // 到期日现算：公司时区的今天，不是服务器 UTC 的今天。
  const today = todayInOrg(context);
  const overdue = showSettlement && balanceMinor > 0n && invoice.dueDate < today;
  const daysOverdue = overdue ? daysBetween(invoice.dueDate, today) : 0;
  const money = (minor: bigint) => formatMoney(minor, invoice.currency, locale);

  return (
    <HeaderIssueProvider>
      <BackLink href={`/${orgSlug}/invoices`}>{t.invoices.title}</BackLink>
      <div className="page-header doc-header">
        <div>
          {/* 不叫「编辑发票」：已作废、已收讫或无权修改时这一页是只读的。 */}
          <h1>
            {t.invoices.detailTitle} <span className="doc-no">{invoice.invoiceNumber}</span>
          </h1>
          <p className="page-subtitle">{invoice.contactName}</p>
        </div>
        <div className="page-header-actions">
          {/* 不自己调 issueInvoice：下面的表单可能有没存的改动，交给表单先存再开具。 */}
          {mayIssue ? (
            <HeaderIssueButton label={t.invoices.issue} loadingLabel={t.common.loading} />
          ) : null}
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
          <Link href={`/${orgSlug}/invoices/${invoice.id}/print`} className="secondary-button">
            <Printer size={18} aria-hidden="true" />
            {t.invoicePdf.print}
          </Link>
        </div>
      </div>

      {/* 草稿不画：金额还在下面的表单里改，这里的数字会跟着过时。 */}
      {showSettlement || isVoided ? (
        <article
          className={`record-detail record-detail--inline doc-summary${isVoided ? ' voided' : ''}`}
        >
          <dl>
            <dt>{t.invoices.total}</dt>
            <dd className={showSettlement && balanceMinor > 0n ? 'mono' : 'mono amount'}>
              {money(invoice.totalMinor)}
            </dd>
            {showSettlement ? (
              <>
                <dt>{t.invoices.amountReceived}</dt>
                <dd className="mono">{money(deductedMinor)}</dd>
              </>
            ) : null}
            {showSettlement && balanceMinor > 0n ? (
              <>
                <dt>
                  {t.invoices.amountOutstanding}
                  {overdue ? (
                    <span className="badge badge-danger">
                      {daysOverdue === 1
                        ? t.invoices.overdueOneDay
                        : interpolate(t.invoices.overdueDays, { n: daysOverdue })}
                    </span>
                  ) : null}
                </dt>
                <dd className="mono amount">{money(balanceMinor)}</dd>
              </>
            ) : null}
          </dl>
        </article>
      ) : null}

      {mayEdit ? null : <p className="hint">{t.common.noEditPermission}</p>}

      <InvoiceForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={contactOptions}
        currencies={[...SUPPORTED_CURRENCIES]}
        baseCurrency={context.baseCurrency}
        invoice={invoice}
        readOnly={!mayEdit}
        overdue={overdue}
      />

      {mayVoid ? (
        <InvoiceVoidButton
          orgSlug={orgSlug}
          locale={locale}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoiceNumber}
        />
      ) : null}
    </HeaderIssueProvider>
  );
}
