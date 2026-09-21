import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreditNoteForm } from '@/components/credit-notes/credit-note-form';
import { DocumentLifecycle } from '@/components/invoices/document-lifecycle';
import { getMessages, interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import { formatScaledRate } from '@/server/domain/exchange-rate';
import { getUserLocale } from '@/server/repositories/organizations';
import { creditNoteAmountsMinor, getCreditNote } from '@/server/repositories/credit_notes';
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
        select id, invoice_number, total_minor
        from invoices
        where organization_id = ${context.organizationId}
          and (status not in ('voided', 'paid') or id = ${found.invoiceId}::uuid)
        order by invoice_number
      `) as { id: string; invoice_number: string; total_minor: bigint }[];

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

  return (
    <>
      <div className="page-header">
        <h1>{interpolate(t.creditNotes.editTitle, { number: creditNote.cnNumber })}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/credit-notes`} className="text-button">
            {t.creditNotes.backToList}
          </Link>
        </div>
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
              quantity: item.quantity,
              // 单价按**单据自己的币种**的小数位还原，不是本位币的：一张
              // JPY 的单据在马币公司里按两位还原会差两个数量级。
              unitPrice: formatMinorToDecimal(item.unitPriceMinor, exponent),
              taxRateId: item.taxRateId,
            })),
          }}
        />
      ) : (
        <article className="record-detail">
          <dl>
            <dt>{t.creditNotes.number}</dt>
            <dd className="mono">{creditNote.cnNumber}</dd>
            <dt>{t.invoices.customer}</dt>
            <dd>{creditNote.contactName}</dd>
            <dt>{t.creditNotes.invoice}</dt>
            <dd>
              {creditNote.invoiceId ? (
                <Link href={`/${orgSlug}/invoices/${creditNote.invoiceId}`}>
                  {invoices.find((inv) => inv.id === creditNote.invoiceId)?.invoice_number ??
                    t.common.viewDetails}
                </Link>
              ) : (
                t.creditNotes.standalone
              )}
            </dd>
            <dt>{t.transaction.date}</dt>
            <dd className="mono">{creditNote.issueDate}</dd>
            <dt>{t.creditNotes.subtotal}</dt>
            <dd className="mono amount">
              {formatMoney(totals.netMinor, creditNote.currency, locale)}
            </dd>
            <dt>{t.creditNotes.tax}</dt>
            <dd className="mono amount">
              {formatMoney(totals.taxMinor, creditNote.currency, locale)}
            </dd>
            <dt>{t.creditNotes.total}</dt>
            <dd className="mono amount">
              {formatMoney(totals.totalMinor, creditNote.currency, locale)}
            </dd>
            {/* 本位币金额单列一行，币种用 context.baseCurrency：
                base_amount_minor 装的是本位币，套单据自己的币种去格式化
                正是列表页修过的那个缺陷。 */}
            <dt>{t.creditNotes.baseTotal}</dt>
            <dd className="mono amount">
              {formatMoney(creditNote.baseAmountMinor, context.baseCurrency, locale)}
            </dd>
            <dt>{t.creditNotes.reason}</dt>
            <dd>{creditNote.reason || '—'}</dd>
            <dt>{t.invoices.notes}</dt>
            <dd>{creditNote.notes || '—'}</dd>
          </dl>

          <h2>{t.invoices.items}</h2>
          <table className="report-table">
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
                  <td className="numeric mono">{item.quantity}</td>
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
        </article>
      )}
    </>
  );
}
