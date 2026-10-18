import { BackLink } from '@/components/ui/back-link';
import { notFound } from 'next/navigation';
import { AssetForm } from '@/components/fixed-assets/asset-form';
import { DepreciationSchedule } from '@/components/fixed-assets/depreciation-schedule';
import { DisposeAssetPanel } from '@/components/fixed-assets/dispose-asset-panel';
import { getMessages, interpolate } from '@/lib/i18n';
import { formatMoney, toIsoDate } from '@/lib/format';
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

  const money = (minor: bigint) => formatMoney(minor, context.baseCurrency, locale);
  const disposed = Boolean(asset.disposedAt) || !asset.isActive;

  return (
    <>
      <BackLink href={`/${orgSlug}/fixed-assets`}>{t.fixedAssets.title}</BackLink>
      {/* 标题是资产自己的名字。原来 h1 是「固定资产」，和上面的返回胶囊
          一字不差；真正的名字是下面一个更小的 h2。 */}
      <div className="page-header">
        <div className="record-heading">
          <h1 className="record-title">{asset.name}</h1>
          {asset.description ? <p className="page-subtitle">{asset.description}</p> : null}
        </div>
        {/* 编辑与处置原来要翻过整张 60 行的折旧表才看得到。 */}
        {asset.isActive ? (
          <div className="page-header-actions">
            <a href="#edit" className="secondary-button">
              {t.common.edit}
            </a>
            <a href="#dispose" className="secondary-button">
              {t.fixedAssets.dispose}
            </a>
          </div>
        ) : null}
      </div>

      {/* 摘要卡：标签在左、值在右，和项目详情、单据详情同一个组件。原来是
          一组左右乱跳的「标签: 值」段落。.fa-summary：手机上改成标签在上、
          值在下（见 settings.css），大号的原值不再把左边的标签挤成两行。 */}
      <article className="record-detail record-detail--inline fa-summary">
        <dl>
          <dt>{t.fixedAssets.status}</dt>
          <dd>
            <span className={`badge ${disposed ? 'badge-warning' : 'badge-success'}`}>
              {disposed ? t.fixedAssets.disposed : t.settings.active}
            </span>
          </dd>
          <dt>{t.fixedAssets.cost}</dt>
          <dd className="mono amount">{money(asset.costMinor)}</dd>
          <dt>{t.fixedAssets.purchaseDate}</dt>
          <dd>{toIsoDate(asset.purchaseDate)}</dd>
          <dt>{t.fixedAssets.salvageValue}</dt>
          <dd className="mono">{money(asset.salvageValueMinor)}</dd>
          <dt>{t.fixedAssets.usefulLifeLabel}</dt>
          <dd>{interpolate(t.fixedAssets.monthsShort, { n: asset.usefulLifeMonths })}</dd>
          <dt>{t.fixedAssets.method}</dt>
          <dd>
            {asset.method === 'straight_line' ? t.fixedAssets.straightLine : t.fixedAssets.decliningBalance}
            {asset.method === 'declining_balance' && asset.decliningRateBps !== null
              ? ` · ${asset.decliningRateBps / 100}%`
              : null}
          </dd>
        </dl>
      </article>

      <DepreciationSchedule
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        asset={asset}
        schedules={schedules}
        locale={locale}
        i18n={t}
      />

      {/* 已处置的资产不给编辑：updateFixedAssetAction 会拒绝，要改先撤销处置。
          编辑排在处置前面：改参数比处置常用得多。 */}
      {asset.isActive ? (
        <section id="edit" className="fa-section">
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
        </section>
      ) : null}

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
    </>
  );
}
