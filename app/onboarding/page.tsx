import { redirect } from 'next/navigation';
import { BackLink } from '@/components/ui/back-link';
import { requireUserId } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations, getUserLocale } from '@/server/repositories/organizations';
import { createOrganization } from '@/server/actions/organizations';
import {
  acceptInvitationById,
  listMyPendingInvitations,
  listMySuspendedCompanies,
} from '@/server/actions/members';
import { AuthError } from '@/server/auth/guard';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userId = await requireUserId();
  const existingOrgs = await listUserOrganizations(userId);
  const query = await searchParams;
  // ?new=1 是「已有公司的人再建一家」的显式入口（侧栏、更多页、公司列表）。
  // 不带它时保持原样：首次流程里已经有公司的人被送进第一家，免得登录后
  // 绕回这一页又被当成新用户。原来这里无条件跳走，于是有公司的人根本
  // 建不了第二家——而「一个人管几套账」正是这个应用的卖点。
  const addingAnother = existingOrgs.length > 0 && query.new === '1';

  if (existingOrgs.length > 0 && !addingAnother) {
    // 已有公司 → 跳第一家
    redirect(`/${existingOrgs[0].slug}`);
  }

  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);
  const roleLabels: Record<string, string> = {
    owner: t.members.roleOwner,
    admin: t.members.roleAdmin,
    bookkeeper: t.members.roleBookkeeper,
    viewer: t.members.roleViewer,
  };
  const nameRejected = query.error === 'name';
  const joinFailed = query.error === 'join';
  const noAccess = query.notice === 'no_access';
  // 没有公司不等于该去建公司：可能有一封邀请在等他（链接弄丢了，或者登录
  // 绕过了邀请页），也可能他唯一的公司把他暂停了。两种都要说清楚。
  const [invitations, suspended] = await Promise.all([
    listMyPendingInvitations(),
    listMySuspendedCompanies(),
  ]);

  return (
    <main className="onboarding-page">
      {addingAnother ? (
        // 返回 '/'：多家公司时列出来选，只有一家时直接回到那一家（见 app/page.tsx）。
        <BackLink href="/">{t.onboarding.back}</BackLink>
      ) : null}
      {noAccess ? (
        <p role="status" className="form-error">
          {t.onboarding.noAccess}
        </p>
      ) : null}
      {suspended.length > 0 ? (
        <p role="status" className="form-error">
          {t.onboarding.suspended.replace('{orgs}', suspended.join(', '))}
        </p>
      ) : null}
      {joinFailed ? (
        <p role="alert" className="form-error">
          {t.onboarding.joinFailed}
        </p>
      ) : null}

      {invitations.length > 0 ? (
        <section aria-labelledby="pending-invitations">
          <h2 id="pending-invitations">{t.onboarding.pendingTitle}</h2>
          <ul>
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <form
                  action={async () => {
                    'use server';
                    let orgSlug: string;
                    try {
                      ({ orgSlug } = await acceptInvitationById(invitation.id));
                    } catch (err) {
                      if (err instanceof AuthError) {
                        redirect(addingAnother ? '/onboarding?new=1&error=join' : '/onboarding?error=join');
                      }
                      throw err;
                    }
                    redirect(`/${orgSlug}`);
                  }}
                >
                  <span>
                    {t.onboarding.pendingItem
                      .replace('{org}', invitation.organizationName)
                      .replace('{role}', roleLabels[invitation.role] ?? invitation.role)}
                  </span>{' '}
                  <button type="submit">{t.onboarding.join}</button>
                </form>
              </li>
            ))}
          </ul>
          <h2>{t.onboarding.orCreate}</h2>
        </section>
      ) : null}

      <h1>{addingAnother ? t.onboarding.newTitle : t.onboarding.title}</h1>
      <p>{addingAnother ? t.onboarding.newSubtitle : t.onboarding.subtitle}</p>

      {/* 服务端校验失败时的回显。原来这里是一句光秃秃的 `return`：
          表单原地不动、什么都不显示，用户只会以为按钮坏了。浏览器原生的
          required/minLength 能挡住大部分情况，但只要绕过（自动填充、
          禁用 JS 的表单提交、直接 POST），这条服务端校验就是唯一的一道，
          而它当时是静默的。redirect 带一个 error 参数回来，不引入客户端
          组件也不动 useActionState，这一页仍然是纯服务端渲染。 */}
      {nameRejected ? (
        <p id="companyName-error" role="alert" className="form-error">
          {t.onboarding.nameTooShort}
        </p>
      ) : null}

      <form
        action={async (formData: FormData) => {
          'use server';
          const name = String(formData.get('companyName') ?? '').trim();
          if (!name || name.length < 2) {
            // 带回 new=1：否则已有公司的人校验失败后会被上面那条分支直接
            // 送进第一家公司，错误提示和刚填的表单一起消失。
            redirect(addingAnother ? '/onboarding?new=1&error=name' : '/onboarding?error=name');
          }

          // 复用 createOrganization：它会在同一事务内写入 owner membership。
          // 少了那一步，accounts / categories 的 RLS 策略（要求 owner 或 admin）
          // 会拒绝 seed 插入，报 "new row violates row-level security policy"。
          const { slug } = await createOrganization({
            name,
            baseCurrency: String(formData.get('baseCurrency') ?? 'MYR').trim().toUpperCase(),
            timezone: String(formData.get('timezone') ?? 'Asia/Kuala_Lumpur').trim(),
            industry: String(formData.get('industry') ?? '').trim() || undefined,
          });

          redirect(`/${slug}`);
        }}
      >
        <label htmlFor="companyName">{t.onboarding.companyName}</label>
        {/* aria-invalid 让 app/globals.css 里那条 input[aria-invalid='true']
            红框规则真正生效（在此之前全站 aria-invalid 用量为 0，那条规则
            是死的），aria-describedby 把上面那句错误信息接到这个字段上，
            读屏在焦点进入输入框时就会念出来。 */}
        <input
          id="companyName"
          name="companyName"
          type="text"
          required
          minLength={2}
          maxLength={120}
          aria-invalid={nameRejected || undefined}
          aria-describedby={nameRejected ? 'companyName-error' : undefined}
        />

        <label htmlFor="baseCurrency">{t.onboarding.baseCurrency}</label>
        <select id="baseCurrency" name="baseCurrency" defaultValue="MYR">
          <option value="MYR">MYR</option>
          <option value="SGD">SGD</option>
          <option value="USD">USD</option>
        </select>
        <p className="hint">{t.onboarding.baseCurrencyHint}</p>

        <label htmlFor="timezone">{t.onboarding.timezone}</label>
        {/* 显示城市名就够了，value 仍是 IANA 名。带「Asia/」前缀时 320px 宽的
            手机上选择框放不下，「(GMT+8)」被下拉箭头盖住一半。 */}
        <select id="timezone" name="timezone" defaultValue="Asia/Kuala_Lumpur">
          <option value="Asia/Kuala_Lumpur">Kuala Lumpur (GMT+8)</option>
          <option value="Asia/Singapore">Singapore (GMT+8)</option>
          <option value="Asia/Shanghai">Shanghai (GMT+8)</option>
        </select>

        <label htmlFor="industry">{t.onboarding.industry}</label>
        {/* 上限与 createOrgSchema 一致：超长时 schema 抛 ZodError，用户看到的是整页错误。 */}
        <input id="industry" name="industry" type="text" maxLength={60} />

        <button type="submit">{t.onboarding.submit}</button>
      </form>
    </main>
  );
}
