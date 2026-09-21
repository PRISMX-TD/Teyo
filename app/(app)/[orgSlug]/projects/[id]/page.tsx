import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getProject, getProjectProfitability } from '@/server/repositories/projects';
import { ProjectProfitability } from '@/components/projects/project-profitability';

/**
 * 一个项目的详情页。
 *
 * 这个路由此前**不存在**：project-list.tsx 里每一行的项目名都链到
 * `/{orgSlug}/projects/{id}`，而 app/(app)/[orgSlug]/projects/ 下只有
 * page.tsx 与 new/ 两项——点项目名得到的是 404。同一个洞在 invoices 与
 * bills 上刚补过，形状完全一样。
 *
 * 服务端其实一直认为这个页面存在：server/actions/projects.ts 的
 * updateProject / setProjectStatus 都在 revalidatePath 这条路径，也就是
 * 一直在让一个从没被渲染过的页面失效。
 */
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  // 与 projects/page.tsx 同一个动作：项目是只读视图，不需要更高的权限，
  // 但也不能比列表页松——列表页看得到的人才该看得到详情。
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const project = await withTransaction(context.userId, (tx) =>
    getProject(tx, context.organizationId, id),
  );

  // getProject 已经按 organization_id 过滤过，所以「查不到」与「不是你的」
  // 在这里是同一件事——两者都只该得到 404，回一句「这个项目属于别家公司」
  // 等于确认了那个 id 在别处存在。
  if (!project) notFound();

  // 盈亏必须等项目确认存在之后再查：getProjectProfitability 对查不到的项目
  // 是直接抛错的（那是给调用方传错 id 用的信号），先查它会把一个本该是 404
  // 的请求变成 500。
  //
  // 口径直接复用列表页用的同一个函数，不在这里另写一条 SQL——项目盈亏和
  // 损益表的口径（本位币、排除作废、按借贷方向取净额）全部集中在那个函数里，
  // 复制一份出来就等于给同一个数字准备了第二个会跑偏的答案。
  const profitability = await withTransaction(context.userId, (tx) =>
    getProjectProfitability(tx, context.organizationId, project.id),
  );

  const statusLabel: Record<string, string> = {
    active: t.projects.statusActive,
    completed: t.projects.statusCompleted,
    cancelled: t.projects.statusCancelled,
  };

  return (
    <>
      <div className="page-header">
        <h1>{project.name}</h1>
        <div className="page-header-actions">
          <Link href={`/${orgSlug}/projects`} className="text-button">
            {t.common.back}
          </Link>
        </div>
      </div>

      <article className="record-detail">
        <dl>
          <dt>{t.projects.status}</dt>
          <dd>
            <span
              className={`badge ${
                project.status === 'active'
                  ? 'badge-success'
                  : project.status === 'completed'
                    ? 'badge-info'
                    : 'badge'
              }`}
            >
              {statusLabel[project.status] ?? project.status}
            </span>
          </dd>
          <dt>{t.projects.client}</dt>
          <dd>{project.contactName ?? t.projects.noClient}</dd>
          <dt>{t.projects.budget}</dt>
          {/* 预算是 bigint 最小货币单位，一律交给 formatMoney 按本位币的小数位
              渲染。任何 Number(x) / 100 这类换算在零小数币种（JPY/KRW/VND）上
              都会差 100 倍——project-list.tsx 里刚修过同一处。 */}
          <dd className="amount">
            {project.budgetMinor === null
              ? '—'
              : formatMoney(project.budgetMinor, context.baseCurrency, locale)}
          </dd>
          <dt>{t.projects.startDate}</dt>
          <dd>{project.startDate ?? '—'}</dd>
          <dt>{t.projects.endDate}</dt>
          <dd>{project.endDate ?? '—'}</dd>
          <dt>{t.projects.description}</dt>
          <dd>{project.description || '—'}</dd>
        </dl>
      </article>

      <h2 className="section-title">{t.projects.profitability}</h2>
      <ProjectProfitability
        profitability={{
          totalIncome: profitability.totalIncomeMinor,
          totalExpense: profitability.totalExpenseMinor,
          netProfit: profitability.netProfitMinor,
        }}
        locale={locale}
        baseCurrency={context.baseCurrency}
      />
    </>
  );
}
