import Link from 'next/link';
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
      <Link href={`/${orgSlug}/settings`} style={{ display: 'inline-block', marginBottom: 'var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        &larr; {locale === 'zh' ? '设置' : 'Settings'}
      </Link>
      <h1>{t.tax.title}</h1>
      <TaxRateList
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        taxRates={taxRates}
      />
    </>
  );
}
