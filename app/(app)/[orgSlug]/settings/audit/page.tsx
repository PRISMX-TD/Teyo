import Link from 'next/link';
import { BackLink } from '@/components/ui/back-link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { listAuditLogs } from '@/server/repositories/audit-logs';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';

export default async function AuditSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ offset?: string }>;
}) {
  const { orgSlug } = await params;
  // audit:read（owner/admin），不是 report:export：audit_logs 的 RLS 只放行
  // owner/admin，用 report:export 时 bookkeeper/viewer 能进这页，但永远只看到
  // 「什么都没发生」——一个看似正常、实则被 RLS 清空的空列表。
  const context = await requirePermission(orgSlug, 'audit:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const offset = Math.max(0, parseInt((await searchParams).offset ?? '0', 10) || 0);
  const limit = 50;

  const rows = await withTransaction(context.userId, (tx) =>
    listAuditLogs(tx, context.organizationId, { limit, offset }),
  );

  // 时间按用户的语言、公司的时区格式化。原来是不带参数的 toLocaleString()，
  // 用的是服务器的语言和时区：英文界面上也是「2026/10/19 02:20:30」，而且
  // 差着公司时区八个小时。时区名非法时退回 UTC，与 todayInOrg 同一个取舍。
  const dateLocale = locale === 'zh' ? 'zh-CN' : 'en-GB';
  let timeFormat: Intl.DateTimeFormat;
  try {
    timeFormat = new Intl.DateTimeFormat(dateLocale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: context.timezone,
    });
  } catch {
    timeFormat = new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  }

  // 「inventory_transaction.recorded」这种是给开发者看的键。有文案的换成一句
  // 人话（「记录了库存出入库」），没有的原样显示，不至于整行空掉。
  const auditMessages = t.audit as Record<string, string>;
  const actionLabel = (action: string): string | null =>
    auditMessages[`act_${action.replaceAll('.', '_')}`] ?? null;

  return (
    <>
      <BackLink href={`/${orgSlug}/settings`}>{t.nav.settings}</BackLink>
      <h1>{t.audit.title}</h1>

      {rows.length === 0 ? (
        <p className="empty-state">{t.audit.empty}</p>
      ) : (
        <table className="audit-table">
          <thead>
            <tr>
              <th>{t.audit.when}</th>
              <th>{t.audit.who}</th>
              <th>{t.audit.what}</th>
              <th>{t.audit.target}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const label = actionLabel(row.action);
              const createdAt = new Date(row.createdAt);
              return (
                <tr key={row.id}>
                  <td className="audit-when">
                    <time dateTime={createdAt.toISOString()}>{timeFormat.format(createdAt)}</time>
                  </td>
                  <td className="audit-who">{row.actorDisplayName ?? '\u2014'}</td>
                  <td className="audit-what">{label ?? row.action}</td>
                  {/* \u52a8\u4f5c\u5df2\u7ecf\u8bf4\u4e86\u662f\u54ea\u4e00\u7c7b\u8bb0\u5f55\uff0c\u8fd9\u91cc\u53ea\u7559\u4e00\u4e2a\u77ed\u7f16\u53f7\u533a\u5206\u540c\u7c7b\u7684\u51e0\u6761\uff1b
                      \u8ba4\u4e0d\u51fa\u7684\u52a8\u4f5c\u624d\u628a\u539f\u59cb\u7c7b\u578b\u4e00\u8d77\u663e\u793a\u3002 */}
                  <td className="audit-target">
                    {label ? null : `${row.entityType} `}
                    {row.entityId ? <span className="mono">#{row.entityId.slice(0, 8)}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* 翻页链接原来的文字是 t.common.loading（「加载中」），而且只有往后翻、
          翻过去就回不来。 */}
      <nav className="pagination" aria-label={t.transaction.pagination}>
        {offset > 0 ? (
          <Link
            className="secondary-button"
            href={`/${orgSlug}/settings/audit?offset=${Math.max(0, offset - limit)}`}
          >
            {t.common.previous}
          </Link>
        ) : null}
        {rows.length >= limit ? (
          <Link className="secondary-button" href={`/${orgSlug}/settings/audit?offset=${offset + limit}`}>
            {t.common.next}
          </Link>
        ) : null}
      </nav>
    </>
  );
}
