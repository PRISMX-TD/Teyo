'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate } from '@/lib/i18n';
import { formatMoney, toIsoDate } from '@/lib/format';
import { postDepreciationAction } from '@/server/actions/fixed-assets';
import type { FixedAssetRow } from '@/server/repositories/fixed-assets';
import { todayLocalISO } from '@/lib/date';

type AccountOption = {
  id: string;
  name_en: string;
  name_zh: string;
};

type Props = {
  orgSlug: string;
  baseCurrency: string;
  locale: Locale;
  i18n: Messages;
  assets: FixedAssetRow[];
  accounts: AccountOption[];
};

export function AssetList({ orgSlug, baseCurrency, locale, i18n: t, assets }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handlePost(assetId: string) {
    setPending(true);
    setError(null);
    try {
      // 本地日期的当月，不是 UTC 的：UTC+8 的月初头八个小时里，
      // toISOString() 给的还是上个月。
      const period = todayLocalISO().slice(0, 7) + '-01';
      await postDepreciationAction(orgSlug, assetId, period);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  function methodLabel(method: string): string {
    return method === 'straight_line' ? t.fixedAssets.straightLine : t.fixedAssets.decliningBalance;
  }

  // 空状态自己就是一张卡，不再套进列表卡片里。
  if (assets.length === 0) {
    return <p className="empty-state">{t.reports.empty}</p>;
  }

  return (
    <>
      <div className="named-list">
        {assets.map((asset) => {
          const detailHref = `/${orgSlug}/fixed-assets/${asset.id}`;
          return (
            <div key={asset.id} className="list-item record-row">
              <div className="record-row-head">
                {/* 名字的链接撑满整张卡（见 .record-row-link）：原来只有名字那一行字能点。 */}
                <Link href={detailHref} className="record-row-link asset-name">
                  {asset.name}
                </Link>
                <span className={`badge ${asset.isActive ? 'badge-success' : 'badge-warning'}`}>
                  {/* 原来处置后显示的是 t.fixedAssets.dispose——那是按钮上的
                      动词「处置」，不是状态。 */}
                  {asset.disposedAt ? t.fixedAssets.disposed : t.settings.active}
                </span>
              </div>
              {/* 四个灰胶囊改成一行小字：胶囊长得像能点的东西。年限原来写成
                  「60M」，挨着金额读起来像六千万。 */}
              <p className="record-row-meta">
                <span>{toIsoDate(asset.purchaseDate)}</span>
                <span>{formatMoney(asset.costMinor, baseCurrency, locale)}</span>
                <span>{interpolate(t.fixedAssets.monthsShort, { n: asset.usefulLifeMonths })}</span>
                <span>{methodLabel(asset.method)}</span>
              </p>
              {/* .doc-actions 会换行：原来这一行不换行，320 宽的英文界面里
                  「View details」被挤成两行、截在卡片右边。 */}
              <div className="doc-actions record-row-actions">
                {asset.isActive && !asset.disposedAt ? (
                  <>
                    <button type="button" onClick={() => handlePost(asset.id)} disabled={pending} className="btn-small">
                      {t.fixedAssets.postDepreciation}
                    </button>
                    {/* 处置要填处置日、收入与收款账户并出一笔分录，表单在详情页。 */}
                    <Link href={`${detailHref}#dispose`} className="btn-small btn-danger">
                      {t.fixedAssets.dispose}
                    </Link>
                  </>
                ) : null}
                <Link href={detailHref} className="btn-small">
                  {t.common.viewDetails}
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </>
  );
}
