import { cache } from 'react';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * 获取当前登录用户 ID。用 React.cache() 去重：同一个请求内
 * root layout、app layout、各页面的 requirePermission 各自调用，
 * 但只会真正向 Supabase Auth API 发一次请求。
 *
 * 未登录时返回 null，不抛错——调用方自行决定如何处理。
 *
 * 注意：middleware 会在 React 渲染前独立跑一次 getUser()（无法共享
 * React 的 request cache），所以每请求仍有一次 middleware 级别的
 * Supabase 往返。React 侧只消耗这次 cache 的结果。
 */
export const getCurrentUserId = cache(async (): Promise<string | null> => {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
});
