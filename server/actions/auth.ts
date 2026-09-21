'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import {
  firstIssueMessage,
  newPasswordSchema,
  resetRequestSchema,
  signInSchema,
  signUpSchema,
} from '@/lib/schemas';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { resolveAnonymousLocale } from '@/lib/i18n/server';
import { createServerClient } from '@/lib/supabase/server';
import { ensureAppUser } from '@/server/auth/ensure-app-user';

/**
 * 「这次登录失败是因为凭据不对」还是「根本没问到服务」。
 *
 * 这个判断必须做，因为两者在界面上是同一个红字。之前登录失败一律把
 * Supabase 的英文原文透传到表单，中文界面上的用户看到的是
 * "Invalid login credentials"；更糟的是网络断了、Supabase 挂了的时候，
 * 那句话同样会变成「密码不对」——用户会去改一个本来没错的密码，甚至
 * 走一遍重置流程，而问题根本不在他这边。
 *
 * 判据优先看 code：supabase-js 从 2.x 起给 AuthApiError 带了稳定的
 * error code，比 message 文本可靠（message 会随 GoTrue 版本改）。
 * message 那一支只是给没有 code 的旧响应兜底。
 */
function isCredentialError(error: { code?: string; message: string }): boolean {
  if (error.code === 'invalid_credentials') return true;
  return /invalid login credentials/i.test(error.message);
}

/**
 * 压根没连上服务的那一类错误。
 *
 * AuthRetryableFetchError 是 supabase-js 对 fetch 失败的包装，它的 status
 * 是 0；某些运行时下连 status 都没有。这一类**不能**显示成凭据错误，也
 * 不该把 "Failed to fetch" 这种实现细节丢给用户——换成 errors.unexpected
 * （「出了点问题，请再试一次」），它说的正是「再试一次」这个正确动作。
 */
function isUnreachableError(error: { name?: string; status?: number }): boolean {
  return error.name === 'AuthRetryableFetchError' || !error.status;
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
  // safeParse 而不是 parse：这个模块的约定是把错误**返回**给表单
  // （见上面 AuthResult 的注释），而 .parse() 抛出的 ZodError 会在生产构建
  // 下被 Next.js 换成脱敏摘要，用户看到的是白屏而不是「密码至少 8 位」。
  const result = signUpSchema.safeParse(input);
  if (!result.success) return { error: firstIssueMessage(result.error) };
  const parsed = result.data;

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
  const result = signInSchema.safeParse(input);
  if (!result.success) return { error: firstIssueMessage(result.error) };
  const parsed = result.data;

  const supabase = await createServerClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.email,
    password: parsed.password,
  });

  if (error) {
    // 语言取自 Accept-Language：这一刻还没有用户身份，app_users.locale 拿不到。
    // 登录页外壳本来就是这样选语言的（见 lib/i18n/server.ts），错误提示跟着
    // 同一个来源，才不会出现「页面是中文、错误是英文」。
    const t = getMessages(await resolveAnonymousLocale());
    if (isCredentialError(error)) return { error: t.auth.invalidCredentials };
    if (isUnreachableError(error)) return { error: t.errors.unexpected };
    // 其余（限流、账号被封、邮箱未确认……）保留 Supabase 的原文：它们各自
    // 带着用户需要的具体信息，翻成一句笼统的中文反而丢掉了那条信息。
    return { error: error.message };
  }

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

/**
 * 发找回密码的邮件。
 *
 * 之前这里连「这串东西长得像不像邮箱」都不验，直接把任意字符串交给
 * Supabase。signInSchema / signUpSchema 的 .email() 在这条路径上一次都不跑，
 * 因为这个函数根本没用 schema。
 *
 * 返回 AuthResult 而不是抛错：这是个表单动作，抛出去用户看到的是错误页。
 * 注意返回值里永远不区分「这个邮箱不存在」和「已经发出去了」——那个区别
 * 会把这个端点变成一台账号枚举机。只有「格式都不对」这一种才回错，
 * 因为它完全不涉及「这个邮箱在不在库里」。
 */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const parsed = resetRequestSchema.safeParse(email);
  if (!parsed.success) {
    return { error: 'That does not look like an email address.' };
  }

  const supabase = await createServerClient();
  const origin = (await headers()).get('origin') ?? '';

  await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${origin}/reset-password`,
  });
}

/**
 * 改密码。
 *
 * 长度校验必须在这里做一遍。signUpSchema 的 min(8) 只管注册表单，这条路径
 * （/reset-password 与 /account 的改密码框）一个字都不经过它，之前是把
 * 任意字符串直接交给 Supabase——包括空串。表单上的 minLength={8} 是 HTML
 * 属性，绕过表单直接调 Server Action 时它不存在。
 */
export async function updatePassword(newPassword: string): Promise<AuthResult> {
  const parsed = newPasswordSchema.safeParse(newPassword);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That password cannot be used.' };
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data });
  if (error) return { error: error.message };
  redirect('/');
}
