'use client';

import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { formatMoney, toIsoDate } from '@/lib/format';
import { postDepreciationAction, disposeFixedAssetAction } from '@/server/actions/fixed_assets';
import type { FixedAssetRow } from '@/server/repositories/fixed_assets';

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
      const period = new Date().toISOString().slice(0, 7) + '-01';
      await postDepreciationAction(orgSlug, assetId, period);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleDispose(assetId: string) {
    setPending(true);
    setError(null);
    try {
      await disposeFixedAssetAction(orgSlug, assetId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  function methodLabel(method: string): string {
    return method === 'straight_line' ? 'Straight Line' : 'Declining Balance';
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
                  {asset.disposedAt ? t.fixedAssets.dispose : t.settings.active}
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
                    <button onClick={() => handlePost(asset.id)} disabled={pending} style={{ minHeight: 36, fontSize: 'var(--text-xs)' }}>
                      {t.fixedAssets.postDepreciation}
                    </button>
                    <button onClick={() => handleDispose(asset.id)} disabled={pending} className="btn-danger" style={{ minHeight: 36, fontSize: 'var(--text-xs)' }}>
                      {t.fixedAssets.dispose}
                    </button>
                  </>
                ) : null}
                <a href={`/${orgSlug}/fixed-assets/${asset.id}`} className="secondary-button" style={{ minHeight: 36, padding: 'var(--space-1) var(--space-3)', fontSize: 'var(--text-xs)' }}>
                  {locale === 'zh' ? '查看详情' : 'View Details'}
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
