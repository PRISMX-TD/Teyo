import Link from 'next/link';
import { getMessages, interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listUncertain } from '@/server/repositories/uncertain';

const PAGE_SIZE = 50;

export default async function UncertainPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const raw = await searchParams;
  const pageParam = Number(raw.page ?? '1');
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // PAGE_SIZE + 1 让我们知道是否还有下一页，不必额外查一次总数——
  // listUncertain 按契约只返回行，不带 total（同 transactions 列表页的做法）。
  const rows = await withTransaction(context.userId, (tx) =>
    listUncertain(tx, context.organizationId, PAGE_SIZE + 1, offset),
  );

  const hasNextPage = rows.length > PAGE_SIZE;
  const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;

  return (
    <>
      <div className="page-header">
        <h1>{t.uncertain.title}</h1>
      </div>

      {/* 这句说明是整个机制成立的关键：告诉用户「挂起」不等于「出错」，
          账依然是平的，只是还没分类。放在列表和空态之上，两种状态下都可见。 */}
      <p className="uncertain-explain">{t.uncertain.explain}</p>

      {pageRows.length === 0 ? (
        <p className="empty-state">{t.uncertain.empty}</p>
      ) : (
        <>
          <ul className="uncertain-list">
            {pageRows.map((row) => (
              <li key={row.id} className="uncertain-row">
                <div className="uncertain-row-info">
                  <span className="uncertain-row-date mono">{row.occurredOn}</span>
                  <span className="uncertain-row-description">
                    {row.description || '—'}
                  </span>
                </div>
                <span className="uncertain-row-amount mono">
                  {formatMoney(row.amountMinor, row.currency, locale)}
                </span>
                <Link
                  href={`/${orgSlug}/transactions/${row.id}`}
                  className="secondary-button"
                >
                  {t.uncertain.resolve}
                </Link>
              </li>
            ))}
          </ul>

          <nav className="pagination" aria-label={t.transaction.pagination}>
            {page > 1 ? (
              <Link
                className="secondary-button"
                href={`/${orgSlug}/uncertain?page=${page - 1}`}
              >
                {t.common.previous}
              </Link>
            ) : null}
            <span className="pagination-page">{interpolate(t.common.pageN, { page })}</span>
            {hasNextPage ? (
              <Link
                className="secondary-button"
                href={`/${orgSlug}/uncertain?page=${page + 1}`}
              >
                {t.common.next}
              </Link>
            ) : null}
          </nav>
        </>
      )}
    </>
  );
}
