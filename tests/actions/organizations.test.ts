import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin, createTestUser, deleteTestOrganizations, deleteTestUser } from '@/tests/helpers/db';

// Server Action 依赖会话层，而它要读 next/headers 的 cookie，node 环境不可用。
// 只 mock 会话，其余（RLS、事务、预置科目、审计）全部走真实数据库。
const user = vi.hoisted(() => ({ id: '' }));

// 只需要 mock getCurrentUserId：requireUserId 与 requirePermission 都在 guard.ts，
// 且都经由 getCurrentUserId 取当前用户，所以真实的鉴权逻辑仍然被测到。
vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: async () => (user.id === '' ? null : user.id),
}));

// next/cache 的 revalidatePath 在测试环境没有请求上下文，会抛错。
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createOrganization, updateOrganization, updatePeriodLock } = await import(
  '@/server/actions/organizations'
);

const createdOrgs: string[] = [];

async function create(name: string, extra: Record<string, string> = {}) {
  const result = await createOrganization({
    name,
    baseCurrency: 'MYR',
    timezone: 'Asia/Kuala_Lumpur',
    ...extra,
  });
  createdOrgs.push(result.id);
  return result;
}

beforeAll(async () => {
  const created = await createTestUser('Boss');
  user.id = created.id;
});

afterAll(async () => {
  await deleteTestOrganizations(createdOrgs);
  await deleteTestUser(user.id);
  await admin.end();
});

describe('createOrganization', () => {
  it('creates the company, an owner membership, seed accounts and seed categories', async () => {
    const result = await create('Acme Trading', { industry: 'retail' });

    expect(result.slug).toBe('acme-trading');

    const [org] = await admin`
      select base_currency, created_by, timezone, industry
      from organizations where id = ${result.id}
    `;
    expect(org.base_currency).toBe('MYR');
    expect(org.created_by).toBe(user.id);
    expect(org.timezone).toBe('Asia/Kuala_Lumpur');
    expect(org.industry).toBe('retail');

    const [membership] = await admin`
      select role, status from memberships
      where organization_id = ${result.id} and user_id = ${user.id}
    `;
    expect(membership.role).toBe('owner');
    expect(membership.status).toBe('active');

    const accounts = await admin`select code from accounts where organization_id = ${result.id}`;
    expect(accounts.length).toBeGreaterThanOrEqual(19);

    const categories = await admin`select id from categories where organization_id = ${result.id}`;
    expect(categories.length).toBeGreaterThanOrEqual(9);

    const [audit] = await admin`
      select action, actor_user_id from audit_logs where organization_id = ${result.id}
    `;
    expect(audit.action).toBe('organization.create');
    expect(audit.actor_user_id).toBe(user.id);
  });

  it('links every seeded category to an account of the matching type', async () => {
    // 分类挂错科目类型，报表的收入/支出分组会整体错位。
    const result = await create('Category Link Co');

    const rows = await admin`
      select c.kind, a.type
      from categories c
      join accounts a on a.id = c.account_id
      where c.organization_id = ${result.id}
    `;

    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const row of rows) {
      expect(row.type).toBe(row.kind === 'income' ? 'revenue' : 'expense');
    }
  });

  it('marks seeded accounts as system accounts and provides a cash money account', async () => {
    const result = await create('Money Account Co');

    const [cash] = await admin`
      select is_money_account, is_system, name_en, name_zh
      from accounts where organization_id = ${result.id} and code = 'cash'
    `;
    expect(cash.is_money_account).toBe(true);
    expect(cash.is_system).toBe(true);
    expect(cash.name_en).toBe('Cash');
    expect(cash.name_zh).toBe('现金');
  });

  it('appends a suffix when the slug is taken', async () => {
    const first = await create('Duplicate Co');
    const second = await create('Duplicate Co');

    expect(first.slug).toBe('duplicate-co');
    expect(second.slug).toMatch(/^duplicate-co-[a-z0-9]+$/);
  });

  it('avoids a slug taken by another user, whose org RLS hides from the caller', async () => {
    // organizations_read 是 app_is_member(id)，调用方看不见别人的公司。
    // 若唯一性检查直接查 organizations 表，这里会撞 unique 约束报裸错误。
    const other = await createTestUser('Other');
    const [foreign] = await admin`
      insert into organizations (name, slug, base_currency, created_by)
      values ('Shared Name Co', 'shared-name-co', 'MYR', ${other.id}) returning id
    `;
    await admin`
      insert into memberships (user_id, organization_id, role, status)
      values (${other.id}, ${foreign.id}, 'owner', 'active')
    `;

    try {
      const mine = await create('Shared Name Co');
      expect(mine.slug).not.toBe('shared-name-co');
      expect(mine.slug).toMatch(/^shared-name-co-[a-z0-9]+$/);
    } finally {
      await admin`delete from organizations where id = ${foreign.id}`;
      await deleteTestUser(other.id);
    }
  });

  it('rejects an invalid payload', async () => {
    await expect(
      createOrganization({ name: '  ', baseCurrency: 'MYR', timezone: 'Asia/Kuala_Lumpur' }),
    ).rejects.toThrow();
  });

  it('rejects an unauthenticated caller', async () => {
    const saved = user.id;
    user.id = '';
    await expect(
      createOrganization({ name: 'Nope', baseCurrency: 'MYR', timezone: 'Asia/Kuala_Lumpur' }),
    ).rejects.toThrow();
    user.id = saved;
  });

  it('leaves nothing behind when the transaction fails', async () => {
    // slug 唯一约束以外的失败路径：币种非法会被 schema 拦在事务之前，
    // 这里用超长 name 触发数据库层报错，确认没有半成品公司残留。
    const before = await admin`select count(*)::int as n from organizations`;

    await expect(
      createOrganization({
        name: 'x'.repeat(200),
        baseCurrency: 'MYR',
        timezone: 'Asia/Kuala_Lumpur',
      }),
    ).rejects.toThrow();

    const after = await admin`select count(*)::int as n from organizations`;
    expect(after[0].n).toBe(before[0].n);
  });
});

describe('updateOrganization', () => {
  it('updates settings and records an audit entry', async () => {
    const org = await create('Editable Co');

    await updateOrganization(org.slug, {
      name: 'Editable Co Renamed',
      timezone: 'Asia/Singapore',
      industry: 'services',
    });

    const [row] = await admin`
      select name, timezone, industry from organizations where id = ${org.id}
    `;
    expect(row.name).toBe('Editable Co Renamed');
    expect(row.timezone).toBe('Asia/Singapore');
    expect(row.industry).toBe('services');

    const actions = await admin`
      select action from audit_logs where organization_id = ${org.id} order by created_at
    `;
    expect(actions.map((a) => a.action)).toContain('organization.update');
  });
});

describe('updatePeriodLock', () => {
  it('locks and unlocks the books with distinct audit actions', async () => {
    const org = await create('Lockable Co');

    await updatePeriodLock(org.slug, { lockedUntil: '2026-03-31' });

    const [locked] = await admin`select locked_until from organizations where id = ${org.id}`;
    // date 列不要用 toISOString 比较，UTC+8 下会退一天。
    expect(
      `${(locked.locked_until as Date).getFullYear()}-${String(
        (locked.locked_until as Date).getMonth() + 1,
      ).padStart(2, '0')}-${String((locked.locked_until as Date).getDate()).padStart(2, '0')}`,
    ).toBe('2026-03-31');

    await updatePeriodLock(org.slug, { lockedUntil: null });

    const [unlocked] = await admin`select locked_until from organizations where id = ${org.id}`;
    expect(unlocked.locked_until).toBeNull();

    const actions = await admin`
      select action from audit_logs where organization_id = ${org.id} order by created_at
    `;
    expect(actions.map((a) => a.action)).toContain('period.lock');
    expect(actions.map((a) => a.action)).toContain('period.unlock');
  });
});
