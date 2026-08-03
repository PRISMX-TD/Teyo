import { ExportForm } from '@/components/export/export-form';
import { getMessages } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { getUserLocale } from '@/server/repositories/organizations';

export default async function ExportPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'report:export');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  return (
    <main>
      <h1>{t.exportPage.title}</h1>
      <p>{t.exportPage.subtitle}</p>
      <ExportForm orgSlug={orgSlug} locale={locale} />
    </main>
  );
}
