import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';
import { getMessages } from '@/lib/i18n';
import { signUp } from '@/server/actions/auth';

export default function SignupPage() {
  const t = getMessages('en');

  async function action(formData: FormData) {
    'use server';
    await signUp({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      displayName: String(formData.get('displayName') ?? ''),
      locale: 'en',
    });
  }

  return (
    <AuthForm
      title={t.auth.signUp}
      submitLabel={t.auth.signUp}
      action={action}
      footer={
        <p>
          <Link href="/login">{t.auth.signIn}</Link>
        </p>
      }
    >
      <label htmlFor="displayName">{t.auth.displayName}</label>
      <input id="displayName" name="displayName" type="text" autoComplete="name" required />

      <label htmlFor="email">{t.auth.email}</label>
      <input id="email" name="email" type="email" autoComplete="email" required />

      <label htmlFor="password">{t.auth.password}</label>
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
