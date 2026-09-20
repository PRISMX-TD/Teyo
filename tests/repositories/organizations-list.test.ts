import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/server/db/client';
import { getUserLocale, listUserOrganizations } from '@/server/repositories/organizations';
import { createTestOrg, createTestUser, joinOrg, resetTestData } from '@/tests/helpers/test-db';

/**
 * 邮箱带随机后缀。auth.users 的邮箱有唯一约束，写死的话一次被中断的跑
 * （afterAll 没执行）就会让这个文件此后永远撞唯一约束——而报错只说
 * "duplicate key"，看不出是残留数据。
 */
const RUN = randomUUID().slice(0, 8);

let bossId: string;
let staffId: string;
let strangerId: string;

beforeAll(async () => {
  await resetTestData();
  bossId = await createTestUser(`test-boss-list-${RUN}@example.com`, 'Boss');
  staffId = await createTestUser(`test-staff-orgs-${RUN}@example.com`, 'Staff');
  strangerId = await createTestUser(`test-stranger-${RUN}@example.com`, 'Stranger');

  const alpha = await createTestOrg(bossId, 'Alpha Trading', 'alpha-trading');
  const beta = await createTestOrg(bossId, 'Beta Cafe', 'beta-cafe');
  await joinOrg(staffId, alpha, 'bookkeeper');
  await sql`update app_users set locale = 'zh' where id = ${staffId}`;
});

afterAll(async () => {
  await resetTestData();
  await sql.end();
});

describe('listUserOrganizations', () => {
  it('returns every company the user actively belongs to, with their role', async () => {
    const orgs = await listUserOrganizations(bossId);

    expect(orgs).toHaveLength(2);
    expect(orgs.map((o) => o.slug).sort()).toEqual(['alpha-trading', 'beta-cafe']);
    expect(orgs.every((o) => o.role === 'owner')).toBe(true);
  });

  it('returns the role for each membership independently', async () => {
    const orgs = await listUserOrganizations(staffId);
    expect(orgs).toEqual([
      expect.objectContaining({ slug: 'alpha-trading', role: 'bookkeeper' }),
    ]);
  });

  it('returns an empty list for a user with no companies', async () => {
    expect(await listUserOrganizations(strangerId)).toEqual([]);
  });

  it('excludes suspended memberships', async () => {
    await sql`
      update memberships set status = 'suspended'
      where user_id = ${staffId}
    `;
    expect(await listUserOrganizations(staffId)).toEqual([]);

    await sql`update memberships set status = 'active' where user_id = ${staffId}`;
  });

  it('sorts by name so the switcher order is stable', async () => {
    const orgs = await listUserOrganizations(bossId);
    expect(orgs.map((o) => o.name)).toEqual(['Alpha Trading', 'Beta Cafe']);
  });
});

describe('getUserLocale', () => {
  it('returns the stored locale', async () => {
    expect(await getUserLocale(staffId)).toBe('zh');
    expect(await getUserLocale(bossId)).toBe('en');
  });

  it('falls back to en for an unknown user', async () => {
    expect(await getUserLocale('00000000-0000-4000-8000-00000000dead')).toBe('en');
  });
});
