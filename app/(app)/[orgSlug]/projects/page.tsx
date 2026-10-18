import Link from 'next/link';
import { BackLink } from '@/components/ui/back-link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';
import { listProjects, getProjectProfitability } from '@/server/repositories/projects';
import { ProjectList } from '@/components/projects/project-list';

export default async function ProjectsListPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);
  // 新建、编辑、改状态三个 action 都要 account:manage。
  const canManage = can(context.role, 'account:manage');

  const projects = await withTransaction(context.userId, async (tx) =>
    listProjects(tx, context.organizationId),
  );

  // Fetch profitability for each project
  const profitabilityEntries = await Promise.all(
    projects.map(async (p) => {
      const profit = await withTransaction(context.userId, async (tx) =>
        getProjectProfitability(tx, context.organizationId, p.id),
      );
      return { id: p.id, profit };
    }),
  );

  const profitabilityMap: Record<string, { totalIncome: bigint; totalExpense: bigint; netProfit: bigint }> = {};
  for (const { id, profit } of profitabilityEntries) {
    profitabilityMap[id] = {
      totalIncome: profit.totalIncomeMinor,
      totalExpense: profit.totalExpenseMinor,
      netProfit: profit.netProfitMinor,
    };
  }

  return (
    <>
      {/* 手机上这一页是从「更多」推进来的，装成 PWA 后没有浏览器返回键。
          桌面上侧栏一直在，不显示（见 app/globals.css「Phone layout」段的 .more-back）。 */}
      <div className="more-back">
        <BackLink href={`/${orgSlug}/more`}>{t.nav.more}</BackLink>
      </div>
      <div className="page-header">
        <h1>{t.projects.title}</h1>
        {canManage ? (
          <div className="page-header-actions">
            <Link href={`/${orgSlug}/projects/new`} className="primary-button">
              {t.projects.newTitle}
            </Link>
          </div>
        ) : null}
      </div>

      <ProjectList
        orgSlug={orgSlug}
        locale={locale}
        projects={projects}
        profitabilityMap={profitabilityMap}
        baseCurrency={context.baseCurrency}
        canManage={canManage}
      />
    </>
  );
}
