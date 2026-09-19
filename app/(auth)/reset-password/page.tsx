import { AuthForm } from '@/components/auth/auth-form';
import { getMessages } from '@/lib/i18n';
import { resolveAnonymousLocale } from '@/lib/i18n/server';
import { updatePassword } from '@/server/actions/auth';

export default async function ResetPasswordPage() {
  const t = getMessages(await resolveAnonymousLocale());

  async function action(formData: FormData) {
    'use server';
    return updatePassword(String(formData.get('password') ?? ''));
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
