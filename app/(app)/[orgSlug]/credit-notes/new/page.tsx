import { CreditNoteForm } from '@/components/credit-notes/credit-note-form';
import { getMessages } from '@/lib/i18n';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewCreditNotePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePagePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const [contacts, invoices] = await Promise.all([
    withTransaction(context.userId, async (tx) => {
      const rows = await tx`
        select id, name
        from contacts
        where organization_id = ${context.organizationId}
          and type in ('customer', 'both')
          and is_active = true
        order by name
      ` as { id: string; name: string }[];
      return rows;
    }),
    withTransaction(context.userId, async (tx) => {
      // 只列开具过、未作废、未收讫的发票：草稿没进总账，冲减它就是凭空贷
      // 一笔应收。contact_id / currency 一起带上，表单选中发票时据此把客户
      // 与币种对齐——createCreditNote 会拒绝两者对不上的组合。
      const rows = await tx`
        select id, invoice_number, contact_id, currency
        from invoices
        where organization_id = ${context.organizationId}
          and voided_at is null
          and status not in ('draft', 'voided', 'paid')
        order by invoice_number
      ` as { id: string; invoice_number: string; contact_id: string; currency: string }[];
      return rows;
    }),
  ]);

  if (contacts.length === 0) {
    return (
      <>
        <h1>{t.creditNotes.newTitle}</h1>
        <p className="empty-state">{t.creditNotes.noContacts}</p>
      </>
    );
  }

  return (
    <>
      <h1>{t.creditNotes.newTitle}</h1>
      <CreditNoteForm
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        contacts={contacts}
        invoices={invoices}
        currencies={[...SUPPORTED_CURRENCIES]}
        // 本位币：既作为币种缺省值，也是汇率栏判断「这是不是一笔外币单据」
        // 的依据——本币时 RateField 整个不渲染。
        baseCurrency={context.baseCurrency}
      />
    </>
  );
}
