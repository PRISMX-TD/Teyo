'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { signInSchema, signUpSchema } from '@/lib/schemas';
import type { Locale } from '@/lib/i18n';
import { createServerClient } from '@/lib/supabase/server';
import { sql } from '@/server/db/client';

/**
 * 往 app_users 写业务资料。用户可能通过邀请链接注册，
 * 所以这个函数必须幂等，且不能用空名字覆盖已有名字。
 */
export async function ensureAppUser(
  userId: string,
  email: string,
  displayName: string,
  locale: Locale,
): Promise<void> {
  const fallback = email.split('@')[0] ?? 'user';
  const name = displayName.trim().length > 0 ? displayName.trim() : fallback;

  await sql`
    insert into app_users (id, email, display_name, locale)
    values (${userId}, ${email}, ${name}, ${locale})
    on conflict (id) do update
      set email = excluded.email,
          display_name = case
            when ${displayName.trim()} = '' then app_users.display_name
            else excluded.display_name
          end
  `;
}

/**
 * Server Action 的返回值。
 *
 * 刻意返回错误而不是 throw：生产构建下 Next.js 会把 action 里未捕获的异常
 * 替换成脱敏摘要并以 500 响应，客户端拿不到原始 message，用户只能看到白屏。
 * 返回值能原样传到表单上，也让 Supabase 的限流、邮箱重复等提示可见。
 */
export type AuthResult = { error: string } | undefined;

export async function signUp(input: {
  email: string;
  password: string;
  displayName: string;
  locale: Locale;
}): Promise<AuthResult> {
  const parsed = signUpSchema.parse(input);
  const supabase = await createServerClient();
  const origin = (await headers()).get('origin') ?? '';

  const { data, error } = await supabase.auth.signUp({
    email: parsed.email,
    password: parsed.password,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      data: { display_name: parsed.displayName, locale: parsed.locale },
    },
  });

  if (error) return { error: error.message };

  // 开启邮箱确认时 data.user 已返回但 auth.users 里还没有提交的行，
  // 此时写 app_users 会撞 app_users_id_fkey。改由 /auth/callback
  // 在确认后补写，这里只在拿到 session（即无需确认）时才写。
  if (data.user && data.session) {
    await ensureAppUser(data.user.id, parsed.email, parsed.displayName, parsed.locale);
  }

  redirect(data.session ? '/onboarding' : '/login?checkEmail=1');
}

export async function signIn(input: {
  email: string;
  password: string;
}): Promise<AuthResult> {
  const parsed = signInSchema.parse(input);
  const supabase = await createServerClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.email,
    password: parsed.password,
  });

  if (error) return { error: error.message };

  if (data.user) {
    const metadata = data.user.user_metadata as { display_name?: string; locale?: Locale };
    await ensureAppUser(
      data.user.id,
      data.user.email ?? parsed.email,
      metadata.display_name ?? '',
      metadata.locale ?? 'en',
    );
  }

  redirect('/');
}

export async function signOut(): Promise<void> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}

export async function requestPasswordReset(email: string): Promise<void> {
  const supabase = await createServerClient();
  const origin = (await headers()).get('origin') ?? '';

  await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: `${origin}/reset-password`,
  });
}

export async function updatePassword(newPassword: string): Promise<AuthResult> {
  const supabase = await createServerClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: error.message };
  redirect('/');
}
