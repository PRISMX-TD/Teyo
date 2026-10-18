'use client';

import { useId, useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate } from '@/lib/i18n';
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

/** 默认只显示这么多期：一年。 */
const WINDOW = 12;

export function DepreciationSchedule({ orgSlug, baseCurrency, asset, schedules, locale, i18n: t }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const tableId = useId();

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

  const pending = posting !== null;

  // 五年期的资产有 60 行，原来整张表全摊开，下面的处置与编辑要翻六千多像素
  // 才够得着。默认只显示一年：从第一期还没过账的前两期开始（看得到刚过的
  // 账），全过完了就显示最后一年。
  const firstUnposted = schedules.findIndex((row) => !row.isPosted);
  const anchor = firstUnposted === -1 ? schedules.length : firstUnposted;
  const start = Math.min(Math.max(0, anchor - 2), Math.max(0, schedules.length - WINDOW));
  const collapsible = schedules.length > WINDOW;
  const visible = showAll || !collapsible ? schedules : schedules.slice(start, start + WINDOW);

  // 资产的名称、原值、年限等原来在这里又排了一遍「标签: 值」的段落，
  // 现在由详情页顶上的摘要卡负责，这里只管折旧表本身。
  return (
    <section className="depreciation-schedule">
      <h2>{t.fixedAssets.schedule}</h2>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      {schedules.length === 0 ? (
        <p className="empty-state">{t.reports.empty}</p>
      ) : (
        <>
          <div className="table-scroll" id={tableId}>
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
                {visible.map((row) => (
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
                          type="button"
                          className="btn-small"
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
          </div>
          {collapsible ? (
            <button
              type="button"
              className="row-button schedule-toggle"
              aria-expanded={showAll}
              aria-controls={tableId}
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll
                ? t.fixedAssets.showFewerPeriods
                : interpolate(t.fixedAssets.showAllPeriods, { count: schedules.length })}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
