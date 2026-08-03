import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';
import { getMessages } from '@/lib/i18n';
import { signIn } from '@/server/actions/auth';

export default function LoginPage() {
  const t = getMessages('en');

  async function action(formData: FormData) {
    'use server';
    await signIn({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
    });
  }

  return (
    <AuthForm
      title={t.auth.signIn}
      submitLabel={t.auth.signIn}
      action={action}
      footer={
        <p>
          <Link href="/forgot-password">{t.auth.forgotPassword}</Link>
          {' · '}
          <Link href="/signup">{t.auth.signUp}</Link>
        </p>
      }
    >
      <label htmlFor="email">{t.auth.email}</label>
      <input id="email" name="email" type="email" autoComplete="email" required />

      <label htmlFor="password">{t.auth.password}</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
    </AuthForm>
  );
}
