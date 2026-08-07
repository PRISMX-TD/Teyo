import Link from 'next/link';
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
  const context = await requirePermission(orgSlug, 'report:export');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const offset = Math.max(0, parseInt((await searchParams).offset ?? '0', 10) || 0);
  const limit = 50;

  const rows = await withTransaction(context.userId, (tx) =>
    listAuditLogs(tx, context.organizationId, { limit, offset }),
  );

  return (
    <>
      <Link href={`/${orgSlug}/settings`} style={{ display: 'inline-block', marginBottom: 'var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        &larr; {locale === 'zh' ? '设置' : 'Settings'}
      </Link>
      <h1>{t.audit.title}</h1>

      {rows.length === 0 ? (
        <p>{t.audit.empty}</p>
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

      {rows.length >= limit ? (
        <a href={`/${orgSlug}/settings/audit?offset=${offset + limit}`}>
          {t.common.loading}
        </a>
      ) : null}
    </>
  );
}
