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

export async function signUp(input: {
  email: string;
  password: string;
  displayName: string;
  locale: Locale;
}): Promise<void> {
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

  if (error) throw new Error(error.message);

  if (data.user) {
    await ensureAppUser(data.user.id, parsed.email, parsed.displayName, parsed.locale);
  }

  redirect('/onboarding');
}

export async function signIn(input: { email: string; password: string }): Promise<void> {
  const parsed = signInSchema.parse(input);
  const supabase = await createServerClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.email,
    password: parsed.password,
  });

  if (error) throw new Error(error.message);

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

export async function updatePassword(newPassword: string): Promise<void> {
  const supabase = await createServerClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
  redirect('/');
}
