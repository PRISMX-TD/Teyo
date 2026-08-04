import { randomUUID } from 'node:crypto';
import { cache } from 'react';
import type { Tx } from '@/server/db/transaction';
import { sql } from '@/server/db/client';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 3 ? base : `co-${base}`.replace(/-+$/g, '').slice(0, 40);
}

/**
 * 用 app_slug_taken 而不是直接 `select ... from organizations where slug = ?`：
 * organizations_read 策略是 app_is_member(id)，在 teyo_app 角色下查不到别人的公司，
 * 会把已被占用的 slug 判为可用，插入时才撞上 unique 约束抛裸错误。
 * app_slug_taken 是 SECURITY DEFINER，只回布尔值。见 0004_slug_availability.sql。
 */
async function isTaken(tx: Tx, candidate: string): Promise<boolean> {
  const [row] = await tx`select app_slug_taken(${candidate}) as taken`;
  return row.taken === true;
}

export async function generateUniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name);

  if (!(await isTaken(tx, base))) return base;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 7)}`;
    if (!(await isTaken(tx, candidate))) return candidate;
  }

  throw new Error('Could not generate a unique slug.');
}

/**
 * 主键在应用侧生成，刻意不用 `insert ... returning id`。
 *
 * Postgres 对 RETURNING 的行会额外施加 SELECT 策略检查，而 organizations_read 是
 * app_is_member(id)：建公司这一刻 owner 的 membership 还没写入，读检查必然失败，
 * 插入会以 "new row violates row-level security policy" 被拒。
 * 自己生成 uuid 就不需要把新行读回来，也不必为此放宽读策略。
 */
export async function insertOrganization(
  tx: Tx,
  input: {
    name: string;
    slug: string;
    baseCurrency: string;
    timezone: string;
    industry: string | null;
    createdBy: string;
  },
): Promise<string> {
  const id = randomUUID();
  await tx`
    insert into organizations (id, name, slug, base_currency, timezone, industry, created_by)
    values (${id}, ${input.name}, ${input.slug}, ${input.baseCurrency}, ${input.timezone},
            ${input.industry}, ${input.createdBy})
  `;
  return id;
}

export async function updateOrganizationSettings(
  tx: Tx,
  organizationId: string,
  input: { name: string; timezone: string; industry: string | null },
): Promise<void> {
  await tx`
    update organizations
    set name = ${input.name}, timezone = ${input.timezone}, industry = ${input.industry}
    where id = ${organizationId}
  `;
}

export async function setPeriodLock(
  tx: Tx,
  organizationId: string,
  lockedUntil: string | null,
): Promise<void> {
  await tx`update organizations set locked_until = ${lockedUntil} where id = ${organizationId}`;
}

export async function listOrganizationsForUser(
  tx: Tx,
  userId: string,
): Promise<Array<{ id: string; name: string; slug: string; role: string }>> {
  const rows = await tx`
    select o.id, o.name, o.slug, m.role
    from organizations o
    join memberships m on m.organization_id = o.id
    where m.user_id = ${userId} and m.status = 'active'
    order by o.name
  `;
  return rows as unknown as Array<{ id: string; name: string; slug: string; role: string }>;
}

/** 公司切换器：列出用户所有活跃成员关系的公司，按名称排序保证 UI 稳定。 */
export async function listUserOrganizations(
  userId: string,
): Promise<Array<{ id: string; name: string; slug: string; role: string }>> {
  const rows = await sql`
    select o.id, o.name, o.slug, m.role
    from organizations o
    join memberships m on m.organization_id = o.id
    where m.user_id = ${userId} and m.status = 'active'
    order by o.name
  `;
  return rows as unknown as Array<{ id: string; name: string; slug: string; role: string }>;
}

/** 取用户语言设置，不存在或为 null 时回退到 en。
 * 用 React.cache() 包裹，同一请求内多次调用只查一次数据库。 */
export const getUserLocale = cache(async (userId: string): Promise<string> => {
  const [row] = await sql`select locale from app_users where id = ${userId}`;
  return (row?.locale as string) ?? 'en';
});
