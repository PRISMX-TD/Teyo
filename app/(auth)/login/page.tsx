import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';
import { getMessages } from '@/lib/i18n';
import { resolveAnonymousLocale } from '@/lib/i18n/server';
import { signIn } from '@/server/actions/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ checkEmail?: string; next?: string }>;
}) {
  const t = getMessages(await resolveAnonymousLocale());
  const { checkEmail, next } = await searchParams;
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
        <p>
          <Link href="/forgot-password">{t.auth.forgotPassword}</Link>
          {' · '}
          <Link href={signupHref}>{t.auth.signUp}</Link>
        </p>
      }
    >
      {checkEmail ? (
        <p role="status" className="form-success">
          {t.auth.confirmEmailSent}
        </p>
      ) : null}

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
