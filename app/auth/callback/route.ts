import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { ensureAppUser } from '@/server/auth/ensure-app-user';
import type { Locale } from '@/lib/i18n';
import { safeNextPath } from '@/lib/safe-next-path';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = safeNextPath(request.nextUrl.searchParams.get('next'));

  if (!code) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const supabase = await createServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(new URL('/login?error=callback', request.url));
  }

  if (data.user) {
    const metadata = data.user.user_metadata as { display_name?: string; locale?: Locale };
    await ensureAppUser(
      data.user.id,
      data.user.email ?? '',
      metadata.display_name ?? '',
      metadata.locale ?? 'en',
    );
  }

  return NextResponse.redirect(new URL(next, request.url));
}
