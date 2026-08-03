import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';
import { getMessages } from '@/lib/i18n';
import { requestPasswordReset } from '@/server/actions/auth';

export default function ForgotPasswordPage() {
  const t = getMessages('en');

  async function action(formData: FormData) {
    'use server';
    await requestPasswordReset(String(formData.get('email') ?? ''));
  }

  return (
    <AuthForm
      title={t.auth.resetPassword}
      submitLabel={t.auth.sendResetLink}
      action={action}
      successMessage={t.auth.resetLinkSent}
      footer={
        <p>
          <Link href="/login">{t.auth.signIn}</Link>
        </p>
      }
    >
      <label htmlFor="email">{t.auth.email}</label>
      <input id="email" name="email" type="email" autoComplete="email" required />
    </AuthForm>
  );
}
