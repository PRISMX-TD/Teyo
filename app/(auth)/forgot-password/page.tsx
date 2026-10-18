import Link from 'next/link';
import { safeNextPath } from '@/lib/safe-next-path';
import { AuthForm } from '@/components/auth/auth-form';
import { getMessages } from '@/lib/i18n';
import { resolveAnonymousLocale } from '@/lib/i18n/server';
import { requestPasswordReset } from '@/server/actions/auth';

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext } = await searchParams;
  // 入口处就收窄成站内路径，拼进链接的值和最终跳转用的值是同一个。
  const next = rawNext ? safeNextPath(rawNext) : undefined;
  const t = getMessages(await resolveAnonymousLocale());

  async function action(formData: FormData) {
    'use server';
    // 必须 return。requestPasswordReset 现在会对「这不像一个邮箱地址」
    // 返回 { error }，而 AuthForm 是靠这个返回值来渲染错误的——把它
    // await 掉再返回 undefined，等于那句校验永远不会显示给用户。
    // reset-password/page.tsx 一直是 return 的写法。
    return requestPasswordReset(String(formData.get('email') ?? ''), next);
  }

  return (
    <AuthForm
      title={t.auth.resetPassword}
      submitLabel={t.auth.sendResetLink}
      action={action}
      successMessage={t.auth.resetLinkSent}
      footer={
        <p className="auth-links">
          <span>
            {t.auth.rememberedPrompt}
            <Link href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}>{t.auth.signIn}</Link>
          </span>
        </p>
      }
    >
      <label htmlFor="email">{t.auth.email}</label>
      <input id="email" name="email" type="email" autoComplete="email" required />
    </AuthForm>
  );
}
