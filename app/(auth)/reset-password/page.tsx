import { AuthForm } from '@/components/auth/auth-form';
import { safeNextPath } from '@/lib/safe-next-path';
import { getMessages } from '@/lib/i18n';
import { resolveAnonymousLocale } from '@/lib/i18n/server';
import { updatePassword } from '@/server/actions/auth';

export default async function ResetPasswordPage({
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
    return updatePassword(String(formData.get('password') ?? ''), next);
  }

  return (
    <AuthForm title={t.auth.resetPassword} submitLabel={t.auth.resetPassword} action={action}>
      <label htmlFor="password">{t.account.newPassword}</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={8}
        required
      />
    </AuthForm>
  );
}
