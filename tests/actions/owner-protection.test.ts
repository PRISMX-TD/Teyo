import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin, createTestUser, deleteTestOrganizations, deleteTestUser } from '@/tests/helpers/db';

const user = vi.hoisted(() => ({ id: '' }));

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: async () => (user.id === '' ? null : user.id),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createOrganization } = await import('@/server/actions/organizations');
const {
  acceptInvitation,
  acceptInvitationById,
  changeMemberRole,
  inviteMember,
  listMyPendingInvitations,
  setMemberStatus,
} = await import('@/server/actions/members');
const { withTransaction } = await import('@/server/db/transaction');

type TestUser = { id: string; email: string };

let owner: TestUser;
let adminA: TestUser;
let adminB: TestUser;
let keeper: TestUser;
let stranger: TestUser;
const lateUsers: TestUser[] = [];
let orgId: string;
let orgSlug: string;

async function membershipId(userId: string): Promise<string> {
  const [row] = await admin`
    select id from memberships where organization_id = ${orgId} and user_id = ${userId}
  `;
  return row.id as string;
}

async function join(member: TestUser, role: 'admin' | 'bookkeeper') {
  user.id = owner.id;
  const { token } = await inviteMember(orgSlug, { email: member.email, role });
  user.id = member.id;
  await acceptInvitation(token);
}

beforeAll(async () => {
  owner = await createTestUser('Owner');
  adminA = await createTestUser('Admin A');
  adminB = await createTestUser('Admin B');
  keeper = await createTestUser('Keeper');
  stranger = await createTestUser('Stranger');

  user.id = owner.id;
  const org = await createOrganization({
    name: 'Owner Protection Co',
    baseCurrency: 'MYR',
    timezone: 'Asia/Kuala_Lumpur',
  });
  orgId = org.id;
  orgSlug = org.slug;

  await join(adminA, 'admin');
  await join(adminB, 'admin');
  await join(keeper, 'bookkeeper');
});

afterAll(async () => {
  await deleteTestOrganizations([orgId]);
  for (const u of [...lateUsers, stranger, keeper, adminB, adminA, owner]) await deleteTestUser(u.id);
  await admin.end();
});

describe('admin hierarchy', () => {
  it('lets an admin manage a bookkeeper', async () => {
    user.id = adminA.id;
    await changeMemberRole(orgSlug, await membershipId(keeper.id), 'viewer');
    await changeMemberRole(orgSlug, await membershipId(keeper.id), 'bookkeeper');
  });

  it('stops an admin from demoting or suspending another admin', async () => {
    user.id = adminA.id;
    const target = await membershipId(adminB.id);
    await expect(changeMemberRole(orgSlug, target, 'viewer')).rejects.toThrow(/only the owner/i);
    await expect(setMemberStatus(orgSlug, target, 'suspended')).rejects.toThrow(/only the owner/i);
  });

  it('stops an admin from granting the admin role, by role change or invitation', async () => {
    user.id = adminA.id;
    await expect(
      changeMemberRole(orgSlug, await membershipId(keeper.id), 'admin'),
    ).rejects.toThrow(/only the owner/i);
    await expect(
      inviteMember(orgSlug, { email: 'new-admin@example.com', role: 'admin' }),
    ).rejects.toThrow(/only the owner/i);
  });

  it('stops anyone from changing their own membership', async () => {
    user.id = adminA.id;
    await expect(
      changeMemberRole(orgSlug, await membershipId(adminA.id), 'viewer'),
    ).rejects.toThrow(/your own membership/i);
  });
});

describe('database-level owner protection', () => {
  it('rejects an admin updating the owner row directly', async () => {
    const ownerRow = await membershipId(owner.id);
    await expect(
      withTransaction(adminA.id, (tx) => tx`update memberships set role = 'viewer' where id = ${ownerRow}`),
    ).rejects.toThrow(/owner_membership_protected/);
    await expect(
      withTransaction(
        adminA.id,
        (tx) => tx`update memberships set status = 'suspended' where id = ${ownerRow}`,
      ),
    ).rejects.toThrow(/owner_membership_protected/);
  });

  it('rejects the owner deleting their own membership', async () => {
    const ownerRow = await membershipId(owner.id);
    await expect(
      withTransaction(owner.id, (tx) => tx`delete from memberships where id = ${ownerRow}`),
    ).rejects.toThrow(/owner_membership_protected/);
  });

  it('rejects a stranger inserting themselves into the company', async () => {
    for (const role of ['admin', 'owner'] as const) {
      await expect(
        withTransaction(
          stranger.id,
          (tx) => tx`
            insert into memberships (user_id, organization_id, role, status)
            values (${stranger.id}, ${orgId}, ${role}, 'active')
          `,
        ),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it('rejects the app deleting an app_users row', async () => {
    await expect(
      withTransaction(stranger.id, (tx) => tx`delete from app_users where id = ${stranger.id}`),
    ).rejects.toThrow(/permission denied/);
  });

  it('still lets the owner keep exactly one active owner after all of the above', async () => {
    const rows = await admin`
      select user_id from memberships
      where organization_id = ${orgId} and role = 'owner' and status = 'active'
    `;
    expect(rows.map((r) => r.user_id)).toEqual([owner.id]);
  });
});

describe('invitation email binding', () => {
  it('refuses a forwarded invitation accepted by a different account', async () => {
    user.id = owner.id;
    const { token } = await inviteMember(orgSlug, { email: 'intended@example.com', role: 'viewer' });

    user.id = stranger.id;
    await expect(acceptInvitation(token)).rejects.toThrow(/different email/i);

    const rows = await admin`
      select 1 from memberships where organization_id = ${orgId} and user_id = ${stranger.id}
    `;
    expect(rows).toHaveLength(0);
  });
});

describe('pending invitations without the link', () => {
  it('lists an invitation for my email and lets me accept it by id, but not someone else', async () => {
    const late = await createTestUser('Late Joiner');
    lateUsers.push(late);
    {
      user.id = owner.id;
      await inviteMember(orgSlug, { email: late.email, role: 'viewer' });

      user.id = stranger.id;
      expect(await listMyPendingInvitations()).toHaveLength(0);

      user.id = late.id;
      const [mine] = await listMyPendingInvitations();
      expect(mine).toMatchObject({ organizationName: 'Owner Protection Co', role: 'viewer' });

      user.id = stranger.id;
      await expect(acceptInvitationById(mine.id)).rejects.toThrow(/not valid/i);

      user.id = late.id;
      expect(await acceptInvitationById(mine.id)).toEqual({ orgSlug });
      expect(await listMyPendingInvitations()).toHaveLength(0);
    }
  });
});
