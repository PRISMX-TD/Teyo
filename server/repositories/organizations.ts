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

export type OrganizationSettings = {
  name: string;
  timezone: string;
  industry: string | null;
  /**
   * 财年起始月（1–12）。0024 迁移加的列，默认 1（日历年）。
   *
   * 读它的唯一原因是：报表默认区间、总账默认区间与年结的期间全都由它决定，
   * 而 OrgContext 里还没有这一列（那个文件不在本次改动范围内）。用一次
   * 独立查询换一个正确的财年，比把日历年硬编码在三个页面里便宜得多。
   */
  fiscalYearStartMonth: number;
};

/**
 * 公司设置。设置页此前**不回填任何一个字段**——表单上 name 是空的、
 * timezone 永远默认吉隆坡、industry 是空的，于是「只想改个行业」的用户
 * 一保存就把公司名清空了（updateOrgSchema 要求 name 非空，实际表现是一句
 * 校验错误，但时区会被静默改回吉隆坡）。有了这个函数，表单可以回填。
 */
export async function getOrganizationSettings(
  tx: Tx,
  organizationId: string,
): Promise<OrganizationSettings> {
  const rows = await tx`
    select name, timezone, industry, fiscal_year_start_month
    from organizations
    where id = ${organizationId}
  `;
  const row = rows.at(0);
  if (!row) {
    throw new Error(`Organization ${organizationId} not found.`);
  }
  return {
    name: row.name as string,
    timezone: (row.timezone as string | null) ?? 'UTC',
    industry: (row.industry as string | null) ?? null,
    // smallint 由驱动解析成 number；列上有 not null default 1 与
    // between 1 and 12 的 CHECK，所以这里不需要再兜底一次。
    fiscalYearStartMonth: row.fiscal_year_start_month as number,
  };
}

export async function updateOrganizationSettings(
  tx: Tx,
  organizationId: string,
  input: {
    name: string;
    timezone: string;
    industry: string | null;
    fiscalYearStartMonth: number;
  },
): Promise<void> {
  await tx`
    update organizations
    set name = ${input.name},
        timezone = ${input.timezone},
        industry = ${input.industry},
        fiscal_year_start_month = ${input.fiscalYearStartMonth}
    where id = ${organizationId}
  `;
}

/**
 * 只取财年起始月。报表页与总账页要的就这一个数字，没必要为它把整行设置
 * 读回来——更重要的是，这两个页面在 requirePermission 之后已经有
 * organizationId，不需要再解析一次公司上下文。
 */
export async function getFiscalYearStartMonth(
  tx: Tx,
  organizationId: string,
): Promise<number> {
  const rows = await tx`
    select fiscal_year_start_month from organizations where id = ${organizationId}
  `;
  const row = rows.at(0);
  if (!row) {
    throw new Error(`Organization ${organizationId} not found.`);
  }
  return row.fiscal_year_start_month as number;
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

/** 公司切换器：列出用户所有活跃成员关系的公司，按名称排序保证 UI 稳定。
 * 用 React.cache() 去重：同一请求内 layout + page 各自调用也只查一次。 */
export const listUserOrganizations = cache(
  async (userId: string): Promise<Array<{ id: string; name: string; slug: string; role: string }>> => {
    const rows = await sql`
      select o.id, o.name, o.slug, m.role
      from organizations o
      join memberships m on m.organization_id = o.id
      where m.user_id = ${userId} and m.status = 'active'
      order by o.name
    `;
    return rows as unknown as Array<{ id: string; name: string; slug: string; role: string }>;
  },
);

/** 取用户语言设置，不存在或为 null 时回退到 en。
 * 用 React.cache() 去重：root layout、app layout、各页面各自调用，
 * 但同一请求内只查一次数据库。 */
export const getUserLocale = cache(async (userId: string): Promise<string> => {
  const [row] = await sql`select locale from app_users where id = ${userId}`;
  return (row?.locale as string) ?? 'en';
});
