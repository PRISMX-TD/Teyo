import { ProjectForm } from '@/components/projects/project-form';
import { BackLink } from '@/components/ui/back-link';
import { getMessages } from '@/lib/i18n';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listContacts } from '@/server/repositories/contacts';

export default async function NewProjectPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  // 与 createProject 同一道权限，否则只读用户看到的是一张必然保存失败的表单。
  const context = await requirePagePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as import('@/lib/i18n').Locale;
  const t = getMessages(locale);

  const contacts = await withTransaction(context.userId, (tx) =>
    listContacts(tx, context.organizationId),
  );

  const activeContacts = contacts
    .filter((c) => c.isActive)
    .map((c) => ({ id: c.id, name: c.name }));

  return (
    <>
      {/* 装成 PWA 后没有浏览器返回键，这一页原来是个死胡同。 */}
      <BackLink href={`/${orgSlug}/projects`}>{t.projects.title}</BackLink>
      <h1>{t.projects.newTitle}</h1>
      <ProjectForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={activeContacts}
      />
    </>
  );
}
