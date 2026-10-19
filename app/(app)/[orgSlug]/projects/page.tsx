import Link from 'next/link';
import { BackLink } from '@/components/ui/back-link';
import { getMessages } from '@/lib/i18n';
import { requirePagePermission } from '@/server/auth/guard';
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
  const context = await requirePagePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);
  // 新建、编辑、改状态三个 action 都要 account:manage。
  const canManage = can(context.role, 'account:manage');

  // 列表与各项目的盈亏放进同一个事务。原来每个项目各开一个事务：N 个项目
  // 就是 N 次 begin / set role / set_config / commit，而连接池只有 3 条
  // （server/db/client.ts），其余的排队——项目一多这一页就线性变慢。
  // 同一事务里的查询由 postgres.js 在一条连接上流水线发送。
  const { projects, profitabilityEntries } = await withTransaction(context.userId, async (tx) => {
    const projects = await listProjects(tx, context.organizationId);
    const profitabilityEntries = await Promise.all(
      projects.map(async (p) => ({
        id: p.id,
        profit: await getProjectProfitability(tx, context.organizationId, p.id),
      })),
    );
    return { projects, profitabilityEntries };
  });

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
