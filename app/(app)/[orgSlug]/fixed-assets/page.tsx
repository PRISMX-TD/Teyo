import Link from 'next/link';
import { BackLink } from '@/components/ui/back-link';
import { AssetList } from '@/components/fixed-assets/asset-list';
import { getMessages } from '@/lib/i18n';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listAllAccounts } from '@/server/repositories/accounts';
import { listFixedAssets } from '@/server/repositories/fixed-assets';

export default async function FixedAssetsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePagePermission(orgSlug, 'account:manage');
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
      {/* 手机上这一页是从「更多」推进来的，装成 PWA 后没有浏览器返回键。
          桌面上侧栏一直在，不显示（见 app/globals.css「Phone layout」段的 .more-back）。 */}
      <div className="more-back">
        <BackLink href={`/${orgSlug}/more`}>{t.nav.more}</BackLink>
      </div>
      <div className="page-header">
        <h1>{t.fixedAssets.title}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/fixed-assets/new`} className="primary-button">
            {t.fixedAssets.newTitle}
          </Link>
        </div>
      </div>
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
