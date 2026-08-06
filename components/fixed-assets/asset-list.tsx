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
            <div className="list-item-line">
              <a href={`/${orgSlug}/fixed-assets/${asset.id}`} className="asset-name">
                {asset.name}
              </a>
              <span className="badge">{toIsoDate(asset.purchaseDate)}</span>
              <span className="badge">{formatMoney(asset.costMinor, baseCurrency, locale)}</span>
              <span className="badge">{asset.usefulLifeMonths}m</span>
              <span className="badge">{methodLabel(asset.method)}</span>
              <span className={`badge ${asset.isActive ? 'badge-info' : 'badge-warning'}`}>
                {asset.disposedAt ? t.fixedAssets.dispose : t.settings.active}
              </span>
              {asset.isActive && !asset.disposedAt ? (
                <>
                  <button onClick={() => handlePost(asset.id)} disabled={pending}>
                    {t.fixedAssets.postDepreciation}
                  </button>
                  <button onClick={() => handleDispose(asset.id)} disabled={pending}>
                    {t.fixedAssets.dispose}
                  </button>
                </>
              ) : null}
              <a href={`/${orgSlug}/fixed-assets/${asset.id}`}>
                {t.settings.rename ?? 'Edit'}
              </a>
            </div>
          </div>
        ))
      )}

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      <a href={`/${orgSlug}/fixed-assets/new`} className="add-button">
        {t.fixedAssets.newTitle}
      </a>
    </div>
  );
}
