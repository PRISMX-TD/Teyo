import { AssetList } from '@/components/fixed-assets/asset-list';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listAllAccounts } from '@/server/repositories/accounts';
import { listFixedAssets } from '@/server/repositories/fixed_assets';

export default async function FixedAssetsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const { assets, accounts } = await withTransaction(context.userId, async (tx) => {
    const [assetsResult, accountsResult] = await Promise.all([
      listFixedAssets(tx, context.organizationId),
      listAllAccounts(tx, context.organizationId),
    ]);
    return { assets: assetsResult, accounts: accountsResult };
  });

  const accountOptions = accounts.map((a) => ({
    id: a.id,
    name_en: a.nameEn ?? '',
    name_zh: a.nameZh ?? '',
  }));

  return (
    <>
      <h1>{t.fixedAssets.title}</h1>
      <AssetList
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        locale={locale}
        i18n={t}
        assets={assets}
        accounts={accountOptions}
      />
    </>
  );
}
