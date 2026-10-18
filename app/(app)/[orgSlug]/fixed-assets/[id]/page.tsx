import { BackLink } from '@/components/ui/back-link';
import { notFound } from 'next/navigation';
import { AssetForm } from '@/components/fixed-assets/asset-form';
import { DepreciationSchedule } from '@/components/fixed-assets/depreciation-schedule';
import { DisposeAssetPanel } from '@/components/fixed-assets/dispose-asset-panel';
import { getMessages } from '@/lib/i18n';
import { requirePermission, todayInOrg } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listAllAccounts, listMoneyAccounts } from '@/server/repositories/accounts';
import {
  getFixedAsset,
  getDepreciationSchedules,
  getDisposalSummary,
} from '@/server/repositories/fixed-assets';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';

/**
 * 一条固定资产的详情/编辑页。
 *
 * 编辑表单此前不在这里：这一页只渲染折旧排程，而
 * updateFixedAssetAction 在 app/ 与 components/ 下零引用——它背后那整套
 * 「改参数后重算折旧表、冻结已过账期间、审计留存改前快照」的逻辑从来
 * 没有被任何用户触发过。表单复用新建那张（components/fixed-assets/asset-form.tsx），
 * 而不是另写一套字段与校验：两套小数位校验里改错一套，另一套看不出来。
 */
export default async function FixedAssetDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  // 这一页本身就是 account:manage（与 updateFixedAssetAction 同一道权限），
  // 所以进得来的人一定改得动，不需要再按角色分出一个只读分支。
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const { asset, schedules, accounts, moneyAccounts, disposal } = await withTransaction(
    context.userId,
    async (tx) => {
      const assetResult = await getFixedAsset(tx, context.organizationId, id);
      if (!assetResult) {
        return { asset: null, schedules: [], accounts: [], moneyAccounts: [], disposal: null };
      }
      const [schedulesResult, accountsResult, moneyAccountsResult, disposalResult] =
        await Promise.all([
          getDepreciationSchedules(tx, context.organizationId, id),
          listAllAccounts(tx, context.organizationId),
          listMoneyAccounts(tx, context.organizationId),
          getDisposalSummary(tx, context.organizationId, assetResult),
        ]);
      return {
        asset: assetResult,
        schedules: schedulesResult,
        accounts: accountsResult,
        moneyAccounts: moneyAccountsResult,
        disposal: disposalResult,
      };
    },
  );

  // getFixedAsset 已经按 organization_id 过滤过，所以「查不到」与「不是你的」
  // 在这里是同一件事，两者都只该得到 404。原来这里抛的是一个裸 Error，
  // Server Component 里没有 error boundary 兜住就是一页 500。
  if (!asset) notFound();

  // 刻意不传 type：表单按 type 把科目分成「资产类」与「费用类」两组下拉框，
  // 而累计折旧是资产的备抵科目，各家公司挂在哪一类都有（新建页也没传）。
  // 一旦过滤掉了这条资产当前挂着的科目，下拉框会静默落到第一项上——用户
  // 只是想改个名字，保存之后科目换了人。
  const accountOptions = accounts.map((a) => ({
    id: a.id,
    name_en: a.nameEn ?? '',
    name_zh: a.nameZh ?? '',
  }));

  return (
    <>
      <BackLink href={`/${orgSlug}/fixed-assets`}>{t.fixedAssets.title}</BackLink>
      <h1>{t.fixedAssets.title}</h1>
      <DepreciationSchedule
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        asset={asset}
        schedules={schedules}
        locale={locale}
        i18n={t}
      />

      <DisposeAssetPanel
        orgSlug={orgSlug}
        assetId={asset.id}
        isActive={asset.isActive}
        baseCurrency={context.baseCurrency}
        today={todayInOrg(context)}
        purchaseDate={asset.purchaseDate}
        moneyAccounts={moneyAccounts.map((a) => ({ id: a.id, name_en: a.nameEn, name_zh: a.nameZh }))}
        disposal={disposal}
        locale={locale}
        i18n={t}
      />

      {/* 已处置的资产不给编辑：updateFixedAssetAction 会拒绝，要改先撤销处置。 */}
      {asset.isActive ? (
        <>
          <h2>{t.fixedAssets.editTitle}</h2>
          <AssetForm
            orgSlug={orgSlug}
            locale={locale}
            i18n={t}
            accounts={accountOptions}
            baseCurrency={context.baseCurrency}
            currencies={[...SUPPORTED_CURRENCIES]}
            asset={asset}
          />
        </>
      ) : null}
    </>
  );
}
