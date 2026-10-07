'use client';

import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { formatMoney, toIsoDate } from '@/lib/format';
import { postDepreciationAction } from '@/server/actions/fixed-assets';
import type { FixedAssetRow, DepreciationScheduleRow } from '@/server/repositories/fixed-assets';

type Props = {
  orgSlug: string;
  baseCurrency: string;
  asset: FixedAssetRow;
  schedules: DepreciationScheduleRow[];
  locale: Locale;
  i18n: Messages;
};

export function DepreciationSchedule({ orgSlug, baseCurrency, asset, schedules, locale, i18n: t }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState<string | null>(null);

  async function handlePost(period: string) {
    setPosting(period);
    setError(null);
    try {
      await postDepreciationAction(orgSlug, asset.id, period);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPosting(null);
    }
  }

  function methodLabel(method: string): string {
    return method === 'straight_line' ? t.fixedAssets.straightLine : t.fixedAssets.decliningBalance;
  }

  const pending = posting !== null;

  return (
    <div className="depreciation-schedule">
      {/* Asset Info Header */}
      <div className="asset-info-header">
        <h2>{asset.name}</h2>
        <p>{t.transaction.description}: {asset.description ?? '—'}</p>
        <p>{t.fixedAssets.purchaseDate}: {toIsoDate(asset.purchaseDate)}</p>
        <p>{t.fixedAssets.cost}: {formatMoney(asset.costMinor, baseCurrency, locale)}</p>
        <p>{t.fixedAssets.salvageValue}: {formatMoney(asset.salvageValueMinor, baseCurrency, locale)}</p>
        {/* 标签里已经写着「（月）」，原来再拼一个写死的英文 months。 */}
        <p>{t.fixedAssets.usefulLife}: {asset.usefulLifeMonths}</p>
        <p>{t.fixedAssets.method}: {methodLabel(asset.method)}</p>
      </div>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      {/* Depreciation Schedule Table */}
      <h3>{t.fixedAssets.schedule}</h3>
      {schedules.length === 0 ? (
        <p className="empty-state">{t.reports.empty}</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr>
              <th>{t.reports.period}</th>
              <th className="numeric">{t.reports.depreciation_cf}</th>
              <th className="numeric">{t.fixedAssets.accumulatedDepreciation}</th>
              <th className="numeric">{t.fixedAssets.bookValue}</th>
              <th>{t.fixedAssets.posted}</th>
              <th>{t.fixedAssets.postDepreciation}</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((row) => (
              <tr key={row.id}>
                <td>{toIsoDate(row.period)}</td>
                <td className="numeric mono">{formatMoney(row.depreciationMinor, baseCurrency, locale)}</td>
                <td className="numeric mono">{formatMoney(row.accumulatedMinor, baseCurrency, locale)}</td>
                <td className="numeric mono">{formatMoney(row.bookValueMinor, baseCurrency, locale)}</td>
                <td>
                  {row.isPosted ? (
                    <span className="badge badge-info">✓</span>
                  ) : (
                    <span className="badge">—</span>
                  )}
                </td>
                <td>
                  {/* 金额为零的期间（年限缩短后被清零的那些）与已处置资产的
                      期间，服务端一定会拒，不画按钮。 */}
                  {!row.isPosted && row.depreciationMinor > 0n && asset.isActive ? (
                    <button
                      onClick={() => handlePost(row.period)}
                      disabled={pending}
                    >
                      {posting === row.period ? t.common.loading : t.fixedAssets.postDepreciation}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
