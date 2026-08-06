import { ProjectForm } from '@/components/projects/project-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { listContacts } from '@/server/repositories/contacts';

export default async function NewProjectPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
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
      <h1>{t.projects.newTitle}</h1>
      <ProjectForm
        orgSlug={orgSlug}
        locale={locale}
        contacts={activeContacts}
      />
    </>
  );
}
