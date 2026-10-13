import { PaymentForm } from '@/components/payments/payment-form';
import { getMessages, localizedName } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import { getUserLocale } from '@/server/repositories/organizations';
import { listOutstandingDocuments } from '@/server/repositories/payments';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewPaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const raw = await searchParams;
  // 从发票页的「记录收款」（或账单页的「记录付款」）进来时带着的那一张。
  const requested =
    typeof raw.invoice === 'string'
      ? { kind: 'invoice' as const, id: raw.invoice }
      : typeof raw.bill === 'string'
        ? { kind: 'bill' as const, id: raw.bill }
        : null;
  const context = await requirePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  /**
   * 未结的发票与账单**必须**在这里查出来传给表单。
   *
   * 此前这个页面渲染 `<PaymentForm … />` 时没有传 outstandingInvoices /
   * outstandingBills，于是用户永远勾不到任何单据。
   *
   * 清单走 listOutstandingDocuments：它排除草稿（未过账，核销它等于凭空贷
   * 一笔应收），余额也扣掉了已签发的贷项通知单——原来这里自己用
   * listInvoices + sumSettledByDocument 拼，这两条都漏了。
   */
  const { contacts, moneyAccounts, outstandingInvoices, outstandingBills } = await withTransaction(
    context.userId,
    async (tx) => {
      const contactRows = await tx`
        select id, name
        from contacts
        where organization_id = ${context.organizationId}
          and is_active = true
        order by name
      ` as { id: string; name: string }[];

      const documents = await listOutstandingDocuments(tx, context.organizationId);
      const accounts = await listMoneyAccounts(tx, context.organizationId);

      // 停用的往来对象如果还欠着钱，也要在下拉框里：点了它的发票，表单会把
      // 往来对象切到它，下拉框里没有这一项的话就会落到别人身上。
      const listed = new Set(contactRows.map((c) => c.id));
      const missing = new Map<string, string>();
      for (const doc of documents) {
        if (!listed.has(doc.contactId)) missing.set(doc.contactId, doc.contactName);
      }

      return {
        moneyAccounts: accounts.map((account) => ({
          id: account.id,
          code: account.code,
          name:
            localizedName({ name_en: account.nameEn, name_zh: account.nameZh }, locale) ||
            account.code,
        })),
        contacts: [
          ...contactRows,
          ...[...missing].map(([id, name]) => ({ id, name })),
        ].sort((a, b) => a.name.localeCompare(b.name)),
        // 表单要的是「总额 + 已付」，这里把已付写成 total − remaining，
        // 余额的口径因此只有 listOutstandingDocuments 一处。
        outstandingInvoices: documents
          .filter((doc) => doc.kind === 'invoice')
          .map((doc) => ({
            id: doc.id,
            invoiceNumber: doc.number,
            customerName: doc.contactName,
            contactId: doc.contactId,
            totalMinor: doc.totalMinor,
            paidMinor: doc.totalMinor - doc.remainingMinor,
            currency: doc.currency,
            dueDate: doc.dueDate,
          })),
        outstandingBills: documents
          .filter((doc) => doc.kind === 'bill')
          .map((doc) => ({
            id: doc.id,
            billNumber: doc.number,
            vendorName: doc.contactName,
            contactId: doc.contactId,
            totalMinor: doc.totalMinor,
            paidMinor: doc.totalMinor - doc.remainingMinor,
            currency: doc.currency,
            dueDate: doc.dueDate,
          })),
      };
    },
  );

  if (contacts.length === 0) {
    return (
      <>
        <h1>{t.payments.newTitle}</h1>
        <p className="empty-state">{t.payments.noContacts}</p>
      </>
    );
  }

  // 只认未结清单里的那一张：已收讫、作废、草稿的都没有可核销的余额，
  // 照着它预填只会让用户填完一整张表再被服务端拒。
  const pool = requested?.kind === 'bill' ? outstandingBills : outstandingInvoices;
  const initialDocument =
    requested && pool.some((doc) => doc.id === requested.id) ? requested : null;

  return (
    <>
      <h1>{t.payments.newTitle}</h1>
      {requested && !initialDocument ? (
        <p role="status" className="hint">
          {t.payments.prefillUnavailable}
        </p>
      ) : null}
      <PaymentForm
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        contacts={contacts}
        type="received"
        currencies={[...SUPPORTED_CURRENCIES]}
        baseCurrency={context.baseCurrency}
        moneyAccounts={moneyAccounts}
        outstandingInvoices={outstandingInvoices}
        outstandingBills={outstandingBills}
        initialDocument={initialDocument}
      />
    </>
  );
}
