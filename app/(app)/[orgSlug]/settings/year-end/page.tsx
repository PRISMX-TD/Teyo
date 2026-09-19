import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { getUserLocale } from '@/server/repositories/organizations';
import { getYearEndOverview } from '@/server/actions/year_end';
import { YEAR_END_POSTING_AVAILABLE } from '@/server/services/year-end-close';
import { YearEndPanel } from '@/components/settings/year-end-panel';

/**
 * 年结页。owner only——requirePermission('period:lock') 与 0024 迁移里
 * fiscal_year_closings 的 insert/delete 策略对齐（那两条策略只认 owner）。
 * 权限选它而不是新增一个 Action 的理由见 server/actions/year_end.ts 顶部。
 *
 * 这一页刻意放在设置里而不是报表里：它是一次写操作，而且是这个产品里影响
 * 面最大的一次——它会永久改变用户看到的资产负债表数字。报表页的每一个
 * 入口都是只读的，混一个不可逆的按钮进去，用户会以为自己只是在看报表。
 */
export default async function YearEndPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'period:lock');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const overview = await getYearEndOverview(orgSlug);

  return (
    <>
      <Link
        href={`/${orgSlug}/settings`}
        style={{
          display: 'inline-block',
          marginBottom: 'var(--space-4)',
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-sm)',
        }}
      >
        &larr; {t.nav.settings}
      </Link>
      <h1>{t.yearEnd.title}</h1>

      <YearEndPanel
        orgSlug={orgSlug}
        locale={locale}
        baseCurrency={context.baseCurrency}
        overview={{
          ...overview,
          // ClosingPlan 里的金额是 bigint。Server Component 传给 Client
          // Component 的 props 要过 React 的序列化，而 bigint 在那里是
          // 不可序列化的——整页会在渲染时抛「BigInt value can't be
          // serialized」。转成字符串再在客户端 BigInt() 回来，全程不经
          // Number，一分钱都不会因为浮点丢精度。
          preview: overview.preview
            ? {
                ...overview.preview,
                netIncomeMinor: overview.preview.netIncomeMinor.toString(),
                lines: overview.preview.lines.map((line) => ({
                  ...line,
                  amountMinor: line.amountMinor.toString(),
                })),
              }
            : null,
          existingClosing: overview.existingClosing
            ? {
                ...overview.existingClosing,
                netIncomeMinor: overview.existingClosing.netIncomeMinor.toString(),
                closedAt: overview.existingClosing.closedAt.toISOString(),
              }
            : null,
          history: overview.history.map((row) => ({
            ...row,
            netIncomeMinor: row.netIncomeMinor.toString(),
            closedAt: row.closedAt.toISOString(),
          })),
        }}
        postingAvailable={YEAR_END_POSTING_AVAILABLE}
      />
    </>
  );
}
