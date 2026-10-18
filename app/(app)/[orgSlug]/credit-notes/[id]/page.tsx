import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreditNoteForm } from '@/components/credit-notes/credit-note-form';
import {
  CreditNoteApplyButton,
  CreditNoteVoidButton,
} from '@/components/credit-notes/credit-note-actions';
import { HeaderIssueButton, HeaderIssueProvider } from '@/components/invoices/header-issue';
import { DocumentLifecycle } from '@/components/invoices/document-lifecycle';
import { trimQuantity } from '@/components/invoices/line-items';
import { BackLink } from '@/components/ui/back-link';
import { getMessages } from '@/lib/i18n';
import { formatMoney, formatQuantity } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import { formatScaledRate } from '@/server/domain/exchange-rate';
import { getUserLocale } from '@/server/repositories/organizations';
import { creditNoteAmountsMinor, getCreditNote } from '@/server/repositories/credit-notes';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/**
 * 一张贷项通知单的详情/编辑页。
 *
 * 这个路由此前**不存在**：credit-notes/ 下只有 page.tsx 与 new/ 两项，
 * 而 updateCreditNoteAction 在 app/ 与 components/ 下零引用——草稿建错了
 * 只能作废重建。结构、权限处理、notFound() 的用法照 invoices/[id] 与
 * bills/[id] 那两页写，它们解决的是同一个问题。
 *
 * 只有草稿能改：updateCreditNoteAction 对已签发的单据直接抛
 * 「already been issued」（tests/actions/credit-notes-posting.test.ts 钉着
 * 这条），所以界面不该让用户填完一整张表单再吃一个报错，而是在这一步就
 * 把表单换成只读视图，并说清为什么。
 */
export default async function CreditNoteDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { creditNote, contacts, invoices } = await withTransaction(
    context.userId,
    async (tx) => {
      const found = await getCreditNote(tx, context.organizationId, id);
      if (!found) return { creditNote: null, contacts: [], invoices: [] };

      const contactRows = (await tx`
        select id, name
        from contacts
        where organization_id = ${context.organizationId}
          and type in ('customer', 'both')
          and (is_active = true or id = ${found.contactId})
        order by name
      `) as { id: string; name: string }[];

      // `or id = ...` 那一支不是多余的：这张单可能挂在一张已收讫的发票上，
      // 而下拉框只列未结清的。少了它，用户打开页面改一句备注、保存，
      // 关联发票就被静默清空了——「这一次不动它」与「解除关联」在服务端
      // 是不同的意思，而表单只能提交它看得见的那个值。
      const invoiceRows = (await tx`
        select id, invoice_number, contact_id, currency
        from invoices
        where organization_id = ${context.organizationId}
          and (
            (voided_at is null and status not in ('draft', 'voided', 'paid'))
            or id = ${found.invoiceId}::uuid
          )
        order by invoice_number
      `) as { id: string; invoice_number: string; contact_id: string; currency: string }[];

      return { creditNote: found, contacts: contactRows, invoices: invoiceRows };
    },
  );

  // getCreditNote 已经按 organization_id 过滤过，所以「查不到」与「不是你的」
  // 在这里是同一件事——两者都只该得到 404，回一句「这张单属于别家公司」
  // 等于确认了那个 id 在别处存在。
  if (!creditNote) notFound();

  const exponent = currencyExponent(creditNote.currency);
  const totals = creditNoteAmountsMinor(creditNote.items);
  const isDraft = creditNote.status === 'draft';
  // updateCreditNoteAction 要的是 transaction:create（owner/admin/bookkeeper），
  // 而这一页只要 transaction:read（viewer 也进得来）。不在这里判一次，viewer
  // 会看到一张填得动却必然保存失败的表单。
  const mayEdit = can(context.role, 'transaction:create');

  const statusNotice = (() => {
    if (creditNote.status === 'voided') return t.creditNotes.voidedNotice;
    if (creditNote.status === 'applied') return t.creditNotes.appliedNotice;
    if (creditNote.status === 'issued') return t.creditNotes.issuedNotice;
    if (!mayEdit) return t.common.noEditPermission;
    return t.creditNotes.draftNotice;
  })();

  // 下一步（发出 / 应用）与作废：与列表卡片同一套条件，都要 transaction:create。
  const hasNextStep = creditNote.status === 'draft' || creditNote.status === 'issued';
  const mayVoid = mayEdit && creditNote.status !== 'voided';

  return (
    <HeaderIssueProvider>
      <BackLink href={`/${orgSlug}/credit-notes`}>{t.creditNotes.title}</BackLink>
      <div className="page-header doc-header">
        <div>
          {/* 不叫「编辑…」：除了有权限的草稿，这一页都是只读的。 */}
          <h1>
            {t.creditNotes.detailTitle} <span className="doc-no">{creditNote.cnNumber}</span>
          </h1>
          <p className="page-subtitle">{creditNote.contactName}</p>
        </div>
        {mayEdit && hasNextStep ? (
          <div className="page-header-actions">
            {/* 草稿的「发出」交给下面的表单先存再发出：直接发出会丢掉没存的改动。 */}
            {isDraft ? (
              <HeaderIssueButton label={t.creditNotes.issue} loadingLabel={t.common.loading} />
            ) : (
              <CreditNoteApplyButton
                orgSlug={orgSlug}
                locale={locale}
                creditNoteId={creditNote.id}
              />
            )}
          </div>
        ) : null}
      </div>

      <DocumentLifecycle
        caption={t.creditNotes.lifecycle}
        steps={[
          { value: 'draft', label: t.creditNotes.statusDraft },
          { value: 'issued', label: t.creditNotes.statusIssued },
          { value: 'applied', label: t.creditNotes.statusApplied },
        ]}
        current={creditNote.status}
        voided={creditNote.status === 'voided'}
        voidedLabel={t.creditNotes.statusVoided}
        notice={statusNotice}
      />

      {isDraft && mayEdit ? (
        <CreditNoteForm
          orgSlug={orgSlug}
          locale={locale}
          i18n={t}
          contacts={contacts}
          invoices={invoices}
          currencies={[...SUPPORTED_CURRENCIES]}
          baseCurrency={context.baseCurrency}
          creditNote={{
            id: creditNote.id,
            cnNumber: creditNote.cnNumber,
            invoiceId: creditNote.invoiceId,
            contactId: creditNote.contactId,
            issueDate: creditNote.issueDate,
            currency: creditNote.currency,
            // 定标整数 -> 十进制字符串只走 formatScaledRate 这一处实现，
            // 它与 parseRateToScaled 精确互逆。
            exchangeRate: formatScaledRate(creditNote.exchangeRate),
            reason: creditNote.reason,
            notes: creditNote.notes,
            items: creditNote.items.map((item) => ({
              description: item.description,
              // numeric(12,4) 原样是 '1.0000'，回填前去掉尾巴的零。
              quantity: trimQuantity(item.quantity),
              // 单价按**单据自己的币种**的小数位还原，不是本位币的：一张
              // JPY 的单据在马币公司里按两位还原会差两个数量级。
              unitPrice: formatMinorToDecimal(item.unitPriceMinor, exponent),
              taxRateId: item.taxRateId,
            })),
          }}
        />
      ) : (
        <>
          {/* 短值一张 value-1 卡片（标签在左、值在右），只有合计是大号数字。
              单号已经在标题里，客户在副标题里，不再各占一行。 */}
          <article className="record-detail record-detail--inline doc-summary">
            <dl>
              <dt>{t.creditNotes.invoice}</dt>
              <dd>
                {creditNote.invoiceId ? (
                  <Link href={`/${orgSlug}/invoices/${creditNote.invoiceId}`}>
                    {creditNote.invoiceNumber ?? t.common.viewDetails}
                  </Link>
                ) : (
                  t.creditNotes.standalone
                )}
              </dd>
              <dt>{t.transaction.date}</dt>
              <dd className="mono">{creditNote.issueDate}</dd>
              <dt>{t.creditNotes.subtotal}</dt>
              <dd className="mono">{formatMoney(totals.netMinor, creditNote.currency, locale)}</dd>
              <dt>{t.creditNotes.tax}</dt>
              <dd className="mono">{formatMoney(totals.taxMinor, creditNote.currency, locale)}</dd>
              <dt>{t.creditNotes.total}</dt>
              <dd className="mono amount">
                {formatMoney(totals.totalMinor, creditNote.currency, locale)}
              </dd>
              {/* 本位币金额单列一行，币种用 context.baseCurrency：
                  base_amount_minor 装的是本位币，套单据自己的币种去格式化
                  正是列表页修过的那个缺陷。单据本身就是本位币时它与合计
                  一模一样，不画。 */}
              {creditNote.currency !== context.baseCurrency ? (
                <>
                  <dt>{t.creditNotes.baseTotal}</dt>
                  <dd className="mono">
                    {formatMoney(creditNote.baseAmountMinor, context.baseCurrency, locale)}
                  </dd>
                </>
              ) : null}
            </dl>
          </article>

          {/* 原因、备注可能是一整段话：留在普通卡片里，手机上标签压在值上面。 */}
          {creditNote.reason || creditNote.notes ? (
            <article className="record-detail doc-summary">
              <dl>
                <dt>{t.creditNotes.reason}</dt>
                <dd>{creditNote.reason || '—'}</dd>
                <dt>{t.invoices.notes}</dt>
                <dd>{creditNote.notes || '—'}</dd>
              </dl>
            </article>
          ) : null}

          <h2>{t.invoices.items}</h2>
          <div className="table-scroll">
            <table className="report-table doc-items-table">
              <thead>
                <tr>
                  <th>{t.invoices.description}</th>
                  <th className="numeric">{t.invoices.quantity}</th>
                  <th className="numeric">{t.invoices.unitPrice}</th>
                  <th className="numeric">{t.invoices.amount}</th>
                </tr>
              </thead>
              <tbody>
                {creditNote.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.description}</td>
                    <td className="numeric mono">{formatQuantity(item.quantity)}</td>
                    <td className="numeric mono">
                      {formatMoney(item.unitPriceMinor, creditNote.currency, locale)}
                    </td>
                    <td className="numeric mono">
                      {formatMoney(item.amountMinor, creditNote.currency, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {mayVoid ? (
        <CreditNoteVoidButton
          orgSlug={orgSlug}
          locale={locale}
          creditNoteId={creditNote.id}
          cnNumber={creditNote.cnNumber}
        />
      ) : null}
    </HeaderIssueProvider>
  );
}
