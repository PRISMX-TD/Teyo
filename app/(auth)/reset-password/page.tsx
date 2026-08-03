import { AuthForm } from '@/components/auth/auth-form';
import { getMessages } from '@/lib/i18n';
import { updatePassword } from '@/server/actions/auth';

export default function ResetPasswordPage() {
  const t = getMessages('en');

  async function action(formData: FormData) {
    'use server';
    await updatePassword(String(formData.get('password') ?? ''));
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
