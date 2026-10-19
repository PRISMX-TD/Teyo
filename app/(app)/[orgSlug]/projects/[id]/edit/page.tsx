import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/uuid';
import { BackLink } from '@/components/ui/back-link';
import { ProjectForm } from '@/components/projects/project-form';
import { getMessages } from '@/lib/i18n';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listContacts } from '@/server/repositories/contacts';
import { getProject } from '@/server/repositories/projects';

/**
 * 编辑一个项目。详情页原来没有任何改动入口，只能回列表在行内改；行内那张
 * 表单还没有「客户」一栏。这里复用新建那张表单，一栏不少。
 */
export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  // 不是 uuid 的 id 进 SQL 是类型错误、整页 500；与「查不到」一样给 404。
  if (!isUuid(id)) notFound();
  // 与 updateProjectAction 同一道权限，否则只读用户看到的是一张必然保存失败的表单。
  const context = await requirePagePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const { project, contacts } = await withTransaction(context.userId, async (tx) => {
    const [projectResult, contactsResult] = await Promise.all([
      getProject(tx, context.organizationId, id),
      listContacts(tx, context.organizationId),
    ]);
    return { project: projectResult, contacts: contactsResult };
  });

  if (!project) notFound();

  // 只列启用的客户，但项目当前挂着的那一个即使已经停用也要留着：不留的话
  // 下拉框落到「无客户」上，用户只改了个名字，保存后客户就被清掉了。
  const contactOptions = contacts
    .filter((c) => c.isActive || c.id === project.contactId)
    .map((c) => ({ id: c.id, name: c.name }));

  return (
    <>
      {/* 返回胶囊上写的是项目名，可能很长：.back-link-clamp 把它截成一行。 */}
      <div className="back-link-clamp">
        <BackLink href={`/${orgSlug}/projects/${project.id}`}>{project.name}</BackLink>
      </div>
      <h1>{t.projects.editTitle}</h1>
      <ProjectForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={contactOptions}
        project={project}
        baseCurrency={context.baseCurrency}
      />
    </>
  );
}
