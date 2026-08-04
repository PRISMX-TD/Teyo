import { cache } from 'react';
import { redirect } from 'next/navigation';
import { withTransaction } from '@/server/db/transaction';
import { can, type Action, type Role } from '@/server/domain/permissions';
import { getCurrentUserId } from '@/server/auth/session';

export type AuthErrorCode = 'unauthenticated' | 'forbidden' | 'not_found';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type OrgContext = {
  userId: string;
  organizationId: string;
  orgSlug: string;
  role: Role;
  baseCurrency: string;
  lockedUntil: string | null;
};

/**
 * 未登录时直接跳登录页，而不是抛 AuthError。
 *
 * 抛错在 Server Component 里没有 error boundary 兜住就是 500，用户看到的是
 * 「An error occurred in the Server Components render」而不是登录表单。
 * middleware 通常会先拦下未登录请求，但它与 getUser() 的会话判定可能不一致
 * （cookie 刷新中、middleware matcher 未覆盖的路径），这里必须能兜住。
 *
 * redirect() 通过抛 NEXT_REDIRECT 实现，Next.js 会识别并转成 307，
 * 所以它不会被当成错误。
 */
export async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId();
  if (!userId) {
    redirect('/login');
  }
  return userId;
}

/**
 * date 列取本地日期部分，不能用 toISOString()。
 * 后者先转 UTC，在 UTC+8 下会把 2026-03-01 变成 2026-02-28。
 */
function toDateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 解析公司上下文：查 org + membership，返回完整 OrgContext。
 * 用 React.cache() 去重：app layout 提前调用预热查询，
 * 页面里的 requirePermission 复用同一结果，零额外 DB 开销。
 */
export const resolveOrgContext = cache(async (orgSlug: string): Promise<OrgContext> => {
  const userId = await requireUserId();

  const rows = await withTransaction(
    userId,
    (tx) => tx`
      select o.id, o.slug, o.base_currency, o.locked_until, m.role
      from organizations o
      join memberships m
        on m.organization_id = o.id
       and m.user_id = ${userId}
       and m.status = 'active'
      where o.slug = ${orgSlug}
    `,
  );

  const row = rows.at(0);
  if (!row) {
    // 故意用 not_found：若对非成员返回 forbidden，就等于确认了这家公司存在。
    throw new AuthError('not_found', 'Company not found.');
  }

  return {
    userId,
    organizationId: row.id as string,
    orgSlug: row.slug as string,
    role: row.role as Role,
    baseCurrency: row.base_currency as string,
    lockedUntil: toDateOnly(row.locked_until as Date | string | null),
  };
});

export function assertPermission(context: OrgContext, action: Action): void {
  if (!can(context.role, action)) {
    throw new AuthError('forbidden', `Your role (${context.role}) cannot perform ${action}.`);
  }
}

export async function requirePermission(orgSlug: string, action: Action): Promise<OrgContext> {
  const context = await resolveOrgContext(orgSlug);
  assertPermission(context, action);
  return context;
}
