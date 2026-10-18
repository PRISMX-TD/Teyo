import Link from 'next/link';
import { safeNextPath } from '@/lib/safe-next-path';
import { AuthForm } from '@/components/auth/auth-form';
import { PasswordInput } from '@/components/auth/password-input';
import { getMessages } from '@/lib/i18n';
import { resolveAnonymousLocale } from '@/lib/i18n/server';
import { signIn } from '@/server/actions/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ checkEmail?: string; next?: string; error?: string }>;
}) {
  const t = getMessages(await resolveAnonymousLocale());
  const { checkEmail, next: rawNext, error } = await searchParams;
  // 入口处就收窄成站内路径，拼进链接的值和最终跳转用的值是同一个。
  const next = rawNext ? safeNextPath(rawNext) : undefined;
  const signupHref = next ? `/signup?next=${encodeURIComponent(next)}` : '/signup';

  async function action(formData: FormData) {
    'use server';
    return signIn({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      next,
    });
  }

  return (
    <AuthForm
      title={t.auth.signIn}
      submitLabel={t.auth.signIn}
      action={action}
      footer={
        // 不用「 · 」连成一句：英文在 320px 下折行时圆点会吊在上一行末尾。
        // 两条各成一块，放不下就整块换行；链接撑到 44px 高，好点。
        <p className="auth-links">
          <Link href={next ? `/forgot-password?next=${encodeURIComponent(next)}` : '/forgot-password'}>{t.auth.forgotPassword}</Link>
          <span>
            {t.auth.noAccountPrompt}
            <Link href={signupHref}>{t.auth.signUp}</Link>
          </span>
        </p>
      }
    >
      {checkEmail ? (
        <p role="status" className="form-success">
          {t.auth.confirmEmailSent}
        </p>
      ) : null}
      {/* /auth/callback 换码失败（确认或重设密码的链接过期、被用过）会带 error=callback
          回到这里。之前没人读它，用户只看到一张空白登录表单，不知道刚才那封邮件没生效。 */}
      {error === 'callback' ? (
        <p role="alert" className="form-error">
          {t.auth.callbackFailed}
        </p>
      ) : null}

      <label htmlFor="email">{t.auth.email}</label>
      <input id="email" name="email" type="email" autoComplete="email" required />

      <label htmlFor="password">{t.auth.password}</label>
      <PasswordInput
        id="password"
        name="password"
        showLabel={t.auth.showPassword}
        hideLabel={t.auth.hidePassword}
        autoComplete="current-password"
        required
      />
    </AuthForm>
  );
}
