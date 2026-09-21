import Link from 'next/link';
import { redirect } from 'next/navigation';
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

/**
 * 保存成功的回执。
 *
 * 这一页的两个保存按钮此前既不跳转也不提示：点下去，表单原地不动，用户
 * 没有任何办法判断改动到底有没有写进去——尤其是公司名这种改完之后长得
 * 和改之前一模一样的字段。这里是 Server Action + 原生 <form>，没有客户端
 * state 可用，所以回执走「保存完 redirect 回本页并带一个查询参数」这条路：
 * 它同时清掉了浏览器里那次 POST，用户刷新页面不会被问「要不要重新提交」。
 *
 * 用两个值而不是一个 ?saved=1，是为了让提示出现在他刚操作的那一节旁边；
 * 页面顶上一句笼统的「已保存」说不清楚保存的是锁账期还是公司资料。
 */
type SavedSection = 'lock' | 'general';

export default async function GeneralSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { orgSlug } = await params;
  const saved = (await searchParams).saved as SavedSection | undefined;
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
      <Link href={`/${orgSlug}/settings`} className="back-link">
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
              redirect(`/${orgSlug}/settings/general?saved=lock`);
            }}
          >
            <input name="lockDate" type="date" required />
            <button type="submit">{t.settings.save}</button>
          </form>
          {saved === 'lock' ? (
            <p role="status" className="form-success">
              {t.settings.saved}
            </p>
          ) : null}
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
              address: String(formData.get('address') ?? '') || undefined,
              fiscalYearStartMonth: String(formData.get('fiscalYearStartMonth') ?? ''),
            });
            redirect(`/${orgSlug}/settings/general?saved=general`);
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

          {/*
            开票方地址。发票单据（invoices/[id]/print）会把它印在公司名下面——
            一张寄给客户的发票上没有开票方地址，很多地方在法律上就不算一张发票。
            这一列是 0026 迁移补的：在此之前 getInvoicePdfData 一直在
            `select name, address from organizations`，而那一列根本不存在，
            于是「下载发票」每一次都撞 42703，从上线起一次都没成功过。
          */}
          <label htmlFor="address">{t.settings.companyAddress}</label>
          <input
            id="address"
            name="address"
            maxLength={300}
            defaultValue={settings.address ?? ''}
          />

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

          {saved === 'general' ? (
            <p role="status" className="form-success">
              {t.settings.saved}
            </p>
          ) : null}

          <button type="submit">{t.settings.save}</button>
        </form>
      </section>
    </>
  );
}
