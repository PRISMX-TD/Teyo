'use client';

import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
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

  return (
    <div className="named-list">
      {assets.length === 0 ? (
        <p className="empty-state">{t.reports.empty}</p>
      ) : (
        assets.map((asset) => (
          <div key={asset.id} className="list-item">
            <div className="list-item-line" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', width: '100%' }}>
                <a href={`/${orgSlug}/fixed-assets/${asset.id}`} className="asset-name" style={{ flex: '1 1 auto', minWidth: 0 }}>
                  {asset.name}
                </a>
                <span className={`badge ${asset.isActive ? 'badge-success' : 'badge-warning'}`}>
                  {/* 原来处置后显示的是 t.fixedAssets.dispose——那是按钮上的
                      动词「处置」，不是状态。 */}
                  {asset.disposedAt ? t.fixedAssets.disposed : t.settings.active}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span className="badge badge-info">{toIsoDate(asset.purchaseDate)}</span>
                <span className="badge badge-info">{formatMoney(asset.costMinor, baseCurrency, locale)}</span>
                <span className="badge badge-info">{asset.usefulLifeMonths}M</span>
                <span className="badge badge-info">{methodLabel(asset.method)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
                {asset.isActive && !asset.disposedAt ? (
                  <>
                    <button onClick={() => handlePost(asset.id)} disabled={pending} className="btn-small">
                      {t.fixedAssets.postDepreciation}
                    </button>
                    {/* 处置要填处置日、收入与收款账户并出一笔分录，表单在详情页。 */}
                    <a href={`/${orgSlug}/fixed-assets/${asset.id}#dispose`} className="btn-small btn-danger">
                      {t.fixedAssets.dispose}
                    </a>
                  </>
                ) : null}
                <a href={`/${orgSlug}/fixed-assets/${asset.id}`} className="secondary-button btn-small">
                  {t.common.viewDetails}
                </a>
              </div>
            </div>
          </div>
        ))
      )}

      {error ? <p role="alert" className="form-error">{error}</p> : null}
    </div>
  );
}
