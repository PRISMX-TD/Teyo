import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/server/db/client';
import {
  createTestOrg,
  createTestUser,
  resetTestData,
} from '@/tests/helpers/test-db';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
  requireUserId: () => {
    if (!currentUserId) throw new Error('unauthenticated');
    return Promise.resolve(currentUserId);
  },
}));

const { getInvitationPreview, updateProfile } = await import('@/server/actions/profile');
const { inviteMember } = await import('@/server/actions/members');

let userId: string;
let ownerId: string;
let orgSlug: string;

beforeAll(async () => {
  await resetTestData();
  userId = await createTestUser('profile@example.com', 'Original Name');
  ownerId = await createTestUser('owner-prof@example.com', 'Owner');
  await createTestOrg(ownerId, 'Preview Co', 'preview-co');
  orgSlug = 'preview-co';
});

afterAll(async () => {
  await resetTestData();
  await sql.end();
});

describe('updateProfile', () => {
  it('updates the display name and locale', async () => {
    currentUserId = userId;
    await updateProfile({ displayName: 'New Name', locale: 'zh' });

    const [row] = await sql`select display_name, locale from app_users where id = ${userId}`;
    expect(row.display_name).toBe('New Name');
    expect(row.locale).toBe('zh');
  });

  it('rejects a blank display name', async () => {
    currentUserId = userId;
    await expect(updateProfile({ displayName: '   ', locale: 'en' })).rejects.toThrow();
  });

  it('requires an authenticated user', async () => {
    currentUserId = null;
    await expect(updateProfile({ displayName: 'Nobody', locale: 'en' })).rejects.toThrow();
    currentUserId = userId;
  });
});

describe('getInvitationPreview', () => {
  it('describes a valid invitation without requiring membership', async () => {
    currentUserId = ownerId;
    const { token } = await inviteMember(orgSlug, {
      email: 'profile@example.com',
      role: 'bookkeeper',
    });

    // 受邀者还不是成员，也必须能看到邀请内容
    currentUserId = userId;
    const preview = await getInvitationPreview(token);
    expect(preview).toEqual({
      organizationName: 'Preview Co',
      role: 'bookkeeper',
      state: 'valid',
    });
  });

  it('reports an invalid token without leaking whether the company exists', async () => {
    currentUserId = userId;
    const preview = await getInvitationPreview('not-a-real-token');
    expect(preview.state).toBe('invalid');
    expect(preview.organizationName).toBe('');
  });

  it('reports an expired invitation', async () => {
    currentUserId = ownerId;
    const { token } = await inviteMember(orgSlug, {
      email: 'expired-preview@example.com',
      role: 'viewer',
    });
    await sql`update invitations set expires_at = now() - interval '1 day' where email = 'expired-preview@example.com'`;

    currentUserId = userId;
    expect((await getInvitationPreview(token)).state).toBe('expired');
  });

  it('reports a revoked invitation', async () => {
    currentUserId = ownerId;
    const { token } = await inviteMember(orgSlug, {
      email: 'revoked-preview@example.com',
      role: 'viewer',
    });
    await sql`update invitations set revoked_at = now() where email = 'revoked-preview@example.com'`;

    currentUserId = userId;
    expect((await getInvitationPreview(token)).state).toBe('revoked');
  });
});
