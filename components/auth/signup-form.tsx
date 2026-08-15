'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';
import { getMessages, type Locale } from '@/lib/i18n';
import { signUp } from '@/server/actions/auth';

/**
 * 注册页在有账号之前没有 locale 可解析——app_users 那行还不存在——所以
 * 语言只能由用户在这一步自己选。选择立刻决定两件事：这个表单接下来显示
 * 的文案，以及写进 app_users.locale 的值，后者是 onboarding、根路径乃至
 * 整个产品之后解析语言的唯一依据（见 getUserLocale）。不选就默认英文的话，
 * 这家店主永远见不到这个选择器之外的任何中文，直到自己摸到 /account。
 *
 * 复用 /account 语言切换器的形状与文案（t.account.language/english/chinese），
 * 不新造一套。
 */
export function SignupForm() {
  const [locale, setLocale] = useState<Locale>('en');
  const t = getMessages(locale);

  async function action(formData: FormData) {
    return signUp({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      displayName: String(formData.get('displayName') ?? ''),
      locale,
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
      <label htmlFor="locale">{t.account.language}</label>
      <select
        id="locale"
        name="locale"
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        <option value="en">{t.account.english}</option>
        <option value="zh">{t.account.chinese}</option>
      </select>

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
