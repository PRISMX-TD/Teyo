import { redirect } from 'next/navigation';
import { requireUserId } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations, getUserLocale } from '@/server/repositories/organizations';
import { createOrganization } from '@/server/actions/organizations';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const userId = await requireUserId();
  const existingOrgs = await listUserOrganizations(userId);

  if (existingOrgs.length > 0) {
    // 已有公司 → 跳第一家
    redirect(`/${existingOrgs[0].slug}`);
  }

  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);
  const nameRejected = (await searchParams).error === 'name';

  return (
    <main className="onboarding-page">
      <h1>{t.onboarding.title}</h1>
      <p>{t.onboarding.subtitle}</p>

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
            redirect('/onboarding?error=name');
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
        <select id="timezone" name="timezone" defaultValue="Asia/Kuala_Lumpur">
          <option value="Asia/Kuala_Lumpur">Asia/Kuala Lumpur (GMT+8)</option>
          <option value="Asia/Singapore">Asia/Singapore (GMT+8)</option>
          <option value="Asia/Shanghai">Asia/Shanghai (GMT+8)</option>
        </select>

        <label htmlFor="industry">{t.onboarding.industry}</label>
        <input id="industry" name="industry" type="text" />

        <button type="submit">{t.onboarding.submit}</button>
      </form>
    </main>
  );
}
