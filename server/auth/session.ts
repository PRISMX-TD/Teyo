import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * 返回当前登录用户的 id，未登录则返回 null。
 *
 * 用 getUser() 而不是 getSession()：前者会向 Supabase 校验 JWT，
 * 后者只解析 cookie，内容可被客户端伪造，不能作为鉴权依据。
 */
export async function getCurrentUserId(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}
