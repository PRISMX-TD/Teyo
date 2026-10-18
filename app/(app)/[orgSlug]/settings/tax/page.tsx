import { BackLink } from '@/components/ui/back-link';
import { Plus } from '@/components/ui/icons';
import { TaxRateList } from '@/components/settings/tax-rate-list';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listTaxRates } from '@/server/repositories/tax';

export default async function TaxSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const taxRates = await withTransaction(context.userId, (tx) =>
    listTaxRates(tx, context.organizationId),
  );

  return (
    <>
      <BackLink href={`/${orgSlug}/settings`}>{t.nav.settings}</BackLink>
      {/* 与分类、联系人同一个样子：页头一个「新增」入口，跳到列表下面的表单。 */}
      <div className="page-header">
        <h1>{t.tax.title}</h1>
        <div className="page-header-actions">
          <a href="#add-tax" className="add-button">
            <Plus size={16} weight="bold" aria-hidden="true" />
            {t.tax.addRate}
          </a>
        </div>
      </div>
      <TaxRateList
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        taxRates={taxRates}
      />
    </>
  );
}
