import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/server/db/client';

// resolveOrgContext 依赖 getCurrentUserId，而后者会读 next/headers 的 cookie，
// 在 vitest 的 node 环境里不可用。这里 mock 会话层，其余（RLS、membership 状态、
// 日期处理）全部走真实数据库，因为这些正是本任务的安全要点。
const currentUser = vi.hoisted(() => ({ id: null as string | null }));

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: async () => currentUser.id,
}));

const { AuthError, resolveOrgContext, requirePermission } = await import('@/server/auth/guard');

const RUN = Date.now().toString(36);
const created: string[] = [];

let ownerId: string;
let viewerId: string;
let outsiderId: string;
let suspendedId: string;
let orgSlug: string;

async function createUser(label: string): Promise<string> {
  const email = `${label}-${RUN}@teyo.test`;
  const [row] = await sql`
    insert into auth.users (id, email) values (gen_random_uuid(), ${email}) returning id
  `;
  await sql`
    insert into app_users (id, email, display_name) values (${row.id}, ${email}, ${label})
  `;
  created.push(row.id as string);
  return row.id as string;
}

beforeAll(async () => {
  ownerId = await createUser('owner');
  viewerId = await createUser('viewer');
  outsiderId = await createUser('outsider');
  suspendedId = await createUser('suspended');

  orgSlug = `guard-co-${RUN}`;
  const [org] = await sql`
    insert into organizations (name, slug, base_currency, locked_until, created_by)
    values ('Guard Co', ${orgSlug}, 'MYR', '2026-03-31', ${ownerId})
    returning id
  `;

  await sql`
    insert into memberships (user_id, organization_id, role, status)
    values
      (${ownerId}, ${org.id}, 'owner', 'active'),
      (${viewerId}, ${org.id}, 'viewer', 'active'),
      (${suspendedId}, ${org.id}, 'admin', 'suspended')
  `;
});

afterAll(async () => {
  await sql`delete from organizations where slug = ${orgSlug}`;
  for (const id of created) {
    await sql`delete from auth.users where id = ${id}`;
  }
  await sql.end();
});

describe('resolveOrgContext', () => {
  it('returns the context for an active member', async () => {
    currentUser.id = ownerId;
    const context = await resolveOrgContext(orgSlug);

    expect(context.userId).toBe(ownerId);
    expect(context.orgSlug).toBe(orgSlug);
    expect(context.role).toBe('owner');
    expect(context.baseCurrency).toBe('MYR');
  });

  it('formats locked_until as a plain date without shifting the day', async () => {
    // toISOString() 会先转 UTC，在 UTC+8 下把 03-31 变成 03-30。
    currentUser.id = ownerId;
    const context = await resolveOrgContext(orgSlug);
    expect(context.lockedUntil).toBe('2026-03-31');
  });

  it('reports not_found for a non-member so it cannot probe which orgs exist', async () => {
    currentUser.id = outsiderId;
    await expect(resolveOrgContext(orgSlug)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('treats a suspended member as not_found', async () => {
    currentUser.id = suspendedId;
    await expect(resolveOrgContext(orgSlug)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports not_found for an organization that does not exist', async () => {
    currentUser.id = ownerId;
    await expect(resolveOrgContext(`missing-${RUN}`)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  // 无会话时改为 redirect('/login') 而不是抛 AuthError：Server Component 里
  // 抛错没有 error boundary 会变成 500，用户看不到登录页。这里断言 redirect
  // 摘要，仍然覆盖「无会话拿不到 org context」这个意图。
  it('redirects to login when there is no session', async () => {
    currentUser.id = null;
    await expect(resolveOrgContext(orgSlug)).rejects.toMatchObject({
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
  });
});

describe('requirePermission', () => {
  it('returns the context when the role allows the action', async () => {
    currentUser.id = ownerId;
    const context = await requirePermission(orgSlug, 'period:lock');
    expect(context.role).toBe('owner');
  });

  it('throws forbidden when the role denies the action', async () => {
    currentUser.id = viewerId;
    await expect(requirePermission(orgSlug, 'transaction:create')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('prefers not_found over forbidden for a non-member', async () => {
    // 顺序很重要：先解析上下文再查权限，否则非成员会收到 forbidden，
    // 等于确认了这家公司存在。
    currentUser.id = outsiderId;
    await expect(requirePermission(orgSlug, 'transaction:create')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws AuthError instances so callers can map codes to responses', async () => {
    currentUser.id = viewerId;
    await expect(requirePermission(orgSlug, 'period:lock')).rejects.toBeInstanceOf(AuthError);
  });
});
