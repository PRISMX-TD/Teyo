import Link from 'next/link';
import { DepreciationSchedule } from '@/components/fixed-assets/depreciation-schedule';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import {
  getFixedAsset,
  getDepreciationSchedules,
} from '@/server/repositories/fixed_assets';

export default async function FixedAssetDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const { asset, schedules } = await withTransaction(context.userId, async (tx) => {
    const assetResult = await getFixedAsset(tx, context.organizationId, id);
    if (!assetResult) throw new Error('Fixed asset not found.');
    const schedulesResult = await getDepreciationSchedules(tx, context.organizationId, id);
    return { asset: assetResult, schedules: schedulesResult };
  });

  return (
    <>
      <Link href={`/${orgSlug}/fixed-assets`} style={{ display: 'inline-block', marginBottom: 'var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        &larr; {locale === 'zh' ? '固定资产列表' : 'Fixed Assets'}
      </Link>
      <h1>{t.fixedAssets.title}</h1>
      <DepreciationSchedule
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        asset={asset}
        schedules={schedules}
        locale={locale}
        i18n={t}
      />
    </>
  );
}
