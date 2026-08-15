import Link from 'next/link';
import { getMessages, interpolate } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { can } from '@/server/domain/permissions';
import { updatePeriodLock, updateOrganization } from '@/server/actions/organizations';
import { getUserLocale } from '@/server/repositories/organizations';

export default async function GeneralSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  return (
    <>
      <Link href={`/${orgSlug}/settings`} style={{ display: 'inline-block', marginBottom: 'var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        &larr; {locale === 'zh' ? '设置' : 'Settings'}
      </Link>
      <h1>{t.settings.general}</h1>

      {can(context.role, 'period:lock') && (
        <section>
          <h2>{t.settings.lockTitle}</h2>
          <p>{t.settings.lockHint}</p>
          <p>
            {context.lockedUntil
              ? interpolate(t.settings.lockCurrent, { date: context.lockedUntil })
              : t.settings.lockNone}
          </p>
          <p>{t.settings.lockWarning}</p>
          <form
            action={async (formData: FormData) => {
              'use server';
              const lockDate = String(formData.get('lockDate') ?? '');
              if (!lockDate) return;
              await updatePeriodLock(orgSlug, { lockedUntil: lockDate || null });
            }}
          >
            <input name="lockDate" type="date" required />
            <button type="submit">{t.settings.save}</button>
          </form>
          {context.lockedUntil && (
            <form
              action={async () => {
                'use server';
                await updatePeriodLock(orgSlug, { lockedUntil: null });
              }}
            >
              <button type="submit" className="btn-danger">
                {t.settings.lockRemove}
              </button>
            </form>
          )}
        </section>
      )}

      <section>
        <h2>{t.settings.general}</h2>
        <form
          action={async (formData: FormData) => {
            'use server';
            await updateOrganization(orgSlug, {
              name: String(formData.get('name') ?? ''),
              timezone: String(formData.get('timezone') ?? ''),
              industry: String(formData.get('industry') ?? '') || undefined,
            });
          }}
        >
          <label htmlFor="name">{t.settings.name}</label>
          <input id="name" name="name" required />

          <label htmlFor="timezone">{t.onboarding.timezone}</label>
          <select id="timezone" name="timezone" defaultValue="Asia/Kuala_Lumpur">
            <option value="Asia/Kuala_Lumpur">Asia/Kuala Lumpur (GMT+8)</option>
            <option value="Asia/Singapore">Asia/Singapore (GMT+8)</option>
            <option value="Asia/Shanghai">Asia/Shanghai (GMT+8)</option>
          </select>

          <label htmlFor="industry">{t.onboarding.industry}</label>
          <input id="industry" name="industry" />

          <button type="submit">{t.settings.save}</button>
        </form>
      </section>
    </>
  );
}
