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
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.createdAt).toLocaleString()}</td>
                <td>{row.actorDisplayName ?? '\u2014'}</td>
                <td>{row.action}</td>
                <td>{row.entityType}{row.entityId ? ` ${row.entityId.slice(0, 8)}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 翻页链接原来的文字是 t.common.loading（「加载中」），而且只有往后翻、
          翻过去就回不来。 */}
      <nav className="pagination">
        {offset > 0 ? (
          <Link href={`/${orgSlug}/settings/audit?offset=${Math.max(0, offset - limit)}`}>
            {t.common.previous}
          </Link>
        ) : null}
        {rows.length >= limit ? (
          <Link href={`/${orgSlug}/settings/audit?offset=${offset + limit}`}>
            {t.common.next}
          </Link>
        ) : null}
      </nav>
    </>
  );
}
