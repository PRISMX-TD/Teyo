import { redirect } from 'next/navigation';
import { AssetForm } from '@/components/fixed-assets/asset-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listAllAccounts } from '@/server/repositories/accounts';

export default async function NewFixedAssetPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const accounts = await withTransaction(context.userId, (tx) =>
    listAllAccounts(tx, context.organizationId),
  );

  const accountOptions = accounts.map((a) => ({
    id: a.id,
    name_en: a.nameEn ?? '',
    name_zh: a.nameZh ?? '',
    type: a.type,
  }));

  async function handleSuccess(id: string) {
    'use server';
    redirect(`/${orgSlug}/fixed-assets/${id}`);
  }

  return (
    <>
      <h1>{t.fixedAssets.newTitle}</h1>
      <AssetForm
        orgSlug={orgSlug}
        locale={locale}
        i18n={t}
        accounts={accountOptions}
        onSuccess={handleSuccess}
      />
    </>
  );
}
