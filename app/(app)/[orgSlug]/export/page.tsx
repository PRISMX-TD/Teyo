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
    <>
      {/* 副标题放进页头：原来它是页头下面一段裸 <p>，下边紧贴着表单卡片。 */}
      <div className="page-header">
        <div>
          <h1>{t.exportPage.title}</h1>
          <p className="page-subtitle">{t.exportPage.subtitle}</p>
        </div>
      </div>
      <ExportForm orgSlug={orgSlug} locale={locale} />
    </>
  );
}
