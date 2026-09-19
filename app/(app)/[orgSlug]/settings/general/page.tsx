import Link from 'next/link';
import { getMessages, interpolate } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { updatePeriodLock, updateOrganization } from '@/server/actions/organizations';
import { getOrganizationSettings, getUserLocale } from '@/server/repositories/organizations';

/**
 * 财年起始月的选项。1–12 按顺序列出，标签由 i18n 的 settings.month1..month12
 * 给出——不用 Intl.DateTimeFormat 动态生成月份名：那会在服务端按运行时
 * locale 渲染一次、在客户端 hydrate 时按浏览器 locale 再渲染一次，两者不同
 * 就是一次 hydration mismatch，而这个页面上没有任何东西会提示它发生了。
 */
const MONTH_KEYS = [
  'month1', 'month2', 'month3', 'month4', 'month5', 'month6',
  'month7', 'month8', 'month9', 'month10', 'month11', 'month12',
] as const;

export default async function GeneralSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 表单此前不回填任何一个字段：name 是空的、时区永远显示吉隆坡、行业是空的。
  // 于是「只想改个行业」的用户一保存，时区就被静默改回吉隆坡——而时区决定
  // todayInOrg，也就是每一张报表的「今天」。回填不是润色，是修一个数据损坏。
  const settings = await withTransaction(context.userId, (tx) =>
    getOrganizationSettings(tx, context.organizationId),
  );

  return (
    <>
      <Link href={`/${orgSlug}/settings`} style={{ display: 'inline-block', marginBottom: 'var(--space-4)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        &larr; {t.nav.settings}
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
              fiscalYearStartMonth: String(formData.get('fiscalYearStartMonth') ?? ''),
            });
          }}
        >
          <label htmlFor="name">{t.settings.name}</label>
          <input id="name" name="name" required defaultValue={settings.name} />

          <label htmlFor="timezone">{t.onboarding.timezone}</label>
          <select id="timezone" name="timezone" defaultValue={settings.timezone}>
            <option value="Asia/Kuala_Lumpur">Asia/Kuala Lumpur (GMT+8)</option>
            <option value="Asia/Singapore">Asia/Singapore (GMT+8)</option>
            <option value="Asia/Shanghai">Asia/Shanghai (GMT+8)</option>
          </select>

          <label htmlFor="industry">{t.onboarding.industry}</label>
          <input id="industry" name="industry" defaultValue={settings.industry ?? ''} />

          <label htmlFor="fiscalYearStartMonth">{t.settings.fiscalYearStart}</label>
          <select
            id="fiscalYearStartMonth"
            name="fiscalYearStartMonth"
            defaultValue={String(settings.fiscalYearStartMonth)}
          >
            {MONTH_KEYS.map((key, index) => (
              <option key={key} value={index + 1}>
                {t.settings[key]}
              </option>
            ))}
          </select>
          <p className="field-hint">{t.settings.fiscalYearStartHint}</p>

          <button type="submit">{t.settings.save}</button>
        </form>
      </section>
    </>
  );
}
