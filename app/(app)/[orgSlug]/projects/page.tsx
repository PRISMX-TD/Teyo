import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listProjects, getProjectProfitability } from '@/server/repositories/projects';
import { listContacts } from '@/server/repositories/contacts';
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
      <div className="page-header">
        <h1>{t.projects.title}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/projects/new`} className="primary-button">
            {t.projects.newTitle}
          </Link>
        </div>
      </div>

      <ProjectList
        orgSlug={orgSlug}
        locale={locale}
        projects={projects}
        profitabilityMap={profitabilityMap}
      />
    </>
  );
}
