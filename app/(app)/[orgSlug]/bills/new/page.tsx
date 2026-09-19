import { BillForm } from '@/components/bills/bill-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listTaxRates } from '@/server/repositories/tax';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

export default async function NewBillPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  // 联系人与税率一趟事务里查完。税率是 0021 之后账单才用得上的东西：
  // 在此之前 bills 上没有 tax_minor 这一列，一张含 6% SST 的账单税额只能
  // 并进费用科目，进项税因此恒为零。
  const { contacts, taxRates } = await withTransaction(context.userId, async (tx) => {
    const rows = await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('vendor', 'both')
        and is_active = true
      order by name
    ` as { id: string; name: string }[];

    const rates = await listTaxRates(tx, context.organizationId);
    return { contacts: rows, taxRates: rates };
  });

  if (contacts.length === 0) {
    return (
      <>
        <h1>{t.bills.newTitle}</h1>
        <p className="empty-state">You need to add a vendor contact first. Go to Settings → Categories to manage contacts.</p>
      </>
    );
  }

  return (
    <>
      <h1>{t.bills.newTitle}</h1>
      <BillForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={contacts}
        currencies={[...SUPPORTED_CURRENCIES]}
        // 理由同发票：表单原来硬写 'USD'，而这是给马来西亚商户做的产品。
        baseCurrency={context.baseCurrency}
        // 双语名称在这里就取好。TaxRateRow 的字段是 nameEn/nameZh，
        // 而 localizedName 收的是 name_en/name_zh——两套命名，让客户端组件
        // 自己去对齐只会让下一个人再对一次。
        taxRates={taxRates.map((rate) => ({
          id: rate.id,
          name: (locale === 'zh' ? rate.nameZh : rate.nameEn) || rate.nameEn || rate.nameZh,
          rateBps: rate.rateBps,
        }))}
      />
    </>
  );
}
