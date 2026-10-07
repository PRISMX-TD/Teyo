import Link from 'next/link';
import { BillForm, type BillFromPurchaseOrder } from '@/components/bills/bill-form';
import { getMessages, interpolate } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import { findActiveBillForPurchaseOrder } from '@/server/repositories/bills';
import { getUserLocale } from '@/server/repositories/organizations';
import { getPurchaseOrder, isPoBillable } from '@/server/repositories/purchase-orders';
import { listTaxRates } from '@/server/repositories/tax';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewBillPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ fromPo?: string | string[] }>;
}) {
  const { orgSlug } = await params;
  const { fromPo: fromPoParam } = await searchParams;
  const fromPo = typeof fromPoParam === 'string' && UUID.test(fromPoParam) ? fromPoParam : null;
  // 与 create 那个 action 同一道权限：只读用户进来只会看到一张必然保存
  // 失败的表单。
  const context = await requirePermission(orgSlug, 'transaction:create');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  // 联系人与税率一趟事务里查完。税率是 0021 之后账单才用得上的东西：
  // 在此之前 bills 上没有 tax_minor 这一列，一张含 6% SST 的账单税额只能
  // 并进费用科目，进项税因此恒为零。
  //
  // ?fromPo=<id>：采购单详情页的「转为账单」。按那张采购单预填，提交时
  // createBill 在同一个事务里核对并把采购单推到 billed。这里的判断只决定
  // 「预不预填」，真正的拦截在服务端（assertPurchaseOrderBillable）。
  const { contacts, taxRates, sourcePo } = await withTransaction(context.userId, async (tx) => {
    const rows = await tx`
      select id, name
      from contacts
      where organization_id = ${context.organizationId}
        and type in ('vendor', 'both')
        and is_active = true
      order by name
    ` as { id: string; name: string }[];

    const rates = await listTaxRates(tx, context.organizationId);

    let po = null;
    if (fromPo) {
      const found = await getPurchaseOrder(tx, context.organizationId, fromPo);
      const billable =
        found !== null &&
        isPoBillable(found.status) &&
        (await findActiveBillForPurchaseOrder(tx, context.organizationId, found.id)) === null;
      po = billable ? found : null;
    }

    return { contacts: rows, taxRates: rates, sourcePo: po };
  });

  let fromPurchaseOrder: BillFromPurchaseOrder | null = null;
  let contactOptions = contacts;
  if (sourcePo) {
    const exponent = currencyExponent(sourcePo.currency);
    // 账单只有一个税率，采购单是逐行的。各行一致就照搬；不一致取第一条
    // 有税率的，并在表单上提醒用户核对。
    const lineRates = sourcePo.items.map((item) => item.taxRateId ?? '');
    const firstTaxed = lineRates.find((id) => id !== '') ?? '';
    fromPurchaseOrder = {
      id: sourcePo.id,
      poNumber: sourcePo.poNumber,
      contactId: sourcePo.contactId,
      currency: sourcePo.currency,
      taxRateId: firstTaxed,
      taxRatesDiffer: new Set(lineRates).size > 1,
      // 账单行只有「描述 + 金额」：金额取采购单行金额（数量 × 单价，已定标），
      // 不在这里再乘一遍。
      items: sourcePo.items.map((item) => ({
        description: item.description,
        amount: formatMinorToDecimal(item.amountMinor, exponent),
      })),
    };
    // 供应商可能已被停用、不在下拉里。表单上这一栏是锁住的，不补回来的话
    // 下拉显示的会是列表里的第一个，提交的却是采购单上的那个。
    if (!contacts.some((c) => c.id === sourcePo.contactId)) {
      contactOptions = [
        { id: sourcePo.contactId, name: sourcePo.contactName ?? sourcePo.poNumber },
        ...contacts,
      ];
    }
  }

  if (contactOptions.length === 0) {
    return (
      <>
        <h1>{t.bills.newTitle}</h1>
        <p className="empty-state">
          {t.bills.noVendors}{' '}
          <Link href={`/${orgSlug}/settings/contacts`}>{t.bills.manageContacts}</Link>
        </p>
      </>
    );
  }

  const currencies: string[] = [...SUPPORTED_CURRENCIES];
  if (sourcePo && !currencies.includes(sourcePo.currency)) currencies.push(sourcePo.currency);

  return (
    <>
      <h1>
        {sourcePo
          ? `${t.bills.newTitle} · ${interpolate(t.bills.fromPurchaseOrder, { number: sourcePo.poNumber })}`
          : t.bills.newTitle}
      </h1>
      {fromPo && !sourcePo ? (
        <p role="alert" className="form-error">
          {t.bills.fromPoUnavailable}
        </p>
      ) : null}
      <BillForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={contactOptions}
        currencies={currencies}
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
        fromPurchaseOrder={fromPurchaseOrder}
      />
    </>
  );
}
