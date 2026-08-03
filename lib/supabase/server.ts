import { createServerClient as _ssr } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return _ssr(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // 在 Server Component 渲染期间无法写 cookie，交给 middleware 刷新。
          }
        },
      },
    },
  );
}

/** 别名：匹配计划的函数名，auth actions 及其他服务端代码引用此名。 */
export async function createServerClient() {
  return createSupabaseServerClient();
}
