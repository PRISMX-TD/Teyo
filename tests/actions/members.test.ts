import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin, createTestUser, deleteTestOrganizations, deleteTestUser } from '@/tests/helpers/db';

const user = vi.hoisted(() => ({ id: '' }));

// 只 mock getCurrentUserId，requireUserId / requirePermission 走真实实现。
vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: async () => (user.id === '' ? null : user.id),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createOrganization } = await import('@/server/actions/organizations');
const {
  acceptInvitation,
  changeMemberRole,
  inviteMember,
  listMembers,
  listInvitations,
  revokeInvitation,
  setMemberStatus,
  transferOwnership,
} = await import('@/server/actions/members');

let ownerId: string;
let staffId: string;
let staffEmail: string;
let orgId: string;
let orgSlug: string;

const extraUsers: string[] = [];

async function newUser(name: string) {
  const created = await createTestUser(name);
  extraUsers.push(created.id);
  return created;
}

beforeAll(async () => {
  const owner = await createTestUser('Owner');
  ownerId = owner.id;
  const staff = await createTestUser('Staff');
  staffId = staff.id;
  staffEmail = staff.email;

  user.id = ownerId;
  const org = await createOrganization({
    name: 'Members Co',
    baseCurrency: 'MYR',
    timezone: 'Asia/Kuala_Lumpur',
  });
  orgId = org.id;
  orgSlug = org.slug;
});

afterAll(async () => {
  await deleteTestOrganizations([orgId]);
  for (const id of extraUsers) await deleteTestUser(id);
  await deleteTestUser(staffId);
  await deleteTestUser(ownerId);
  await admin.end();
});

describe('inviteMember', () => {
  it('creates a pending invitation and stores only the token hash', async () => {
    user.id = ownerId;
    const invitee = await newUser('Hashed');
    const { token } = await inviteMember(orgSlug, { email: invitee.email, role: 'bookkeeper' });

    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const rows = await admin`
      select token_hash, role, expires_at from invitations where email = ${invitee.email}
    `;
    expect(rows).toHaveLength(1);
    // 明文 token 绝不落库，泄露数据库也无法反推出邀请链接。
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].role).toBe('bookkeeper');
    // TTL 应落在 7 天后，而不是 7 秒或 7 分钟后。
    const days = ((rows[0].expires_at as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.5);
    expect(days).toBeLessThan(7.5);
  });

  it('refuses to invite someone as owner', async () => {
    user.id = ownerId;
    await expect(
      inviteMember(orgSlug, { email: 'x@example.com', role: 'owner' as never }),
    ).rejects.toThrow();
  });

  it('normalises the email to lowercase', async () => {
    user.id = ownerId;
    await inviteMember(orgSlug, { email: 'MiXeD@Example.COM', role: 'viewer' });
    const rows = await admin`select email from invitations where email = 'mixed@example.com'`;
    expect(rows).toHaveLength(1);
  });

  it('rejects a second pending invitation for the same email', async () => {
    user.id = ownerId;
    const invitee = await newUser('Dupe');
    await inviteMember(orgSlug, { email: invitee.email, role: 'viewer' });
    await expect(inviteMember(orgSlug, { email: invitee.email, role: 'viewer' })).rejects.toThrow();
  });

  it('records an audit entry that does not leak the token', async () => {
    user.id = ownerId;
    const invitee = await newUser('Audited');
    const { token } = await inviteMember(orgSlug, { email: invitee.email, role: 'viewer' });

    const rows = await admin`
      select after::text as after from audit_logs
      where organization_id = ${orgId} and action = 'invitation.created'
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.after).not.toContain(token);
    }
  });
});

describe('acceptInvitation', () => {
  it('turns an invitation into an active membership with the invited role', async () => {
    user.id = ownerId;
    const { token } = await inviteMember(orgSlug, { email: staffEmail, role: 'bookkeeper' });

    user.id = staffId;
    const result = await acceptInvitation(token);
    expect(result.orgSlug).toBe(orgSlug);

    const [membership] = await admin`
      select role, status from memberships
      where organization_id = ${orgId} and user_id = ${staffId}
    `;
    expect(membership.role).toBe('bookkeeper');
    expect(membership.status).toBe('active');

    const [invitation] = await admin`
      select accepted_at from invitations
      where organization_id = ${orgId} and email = ${staffEmail}
    `;
    expect(invitation.accepted_at).not.toBeNull();
  });

  it('rejects reusing a token that was already accepted', async () => {
    user.id = ownerId;
    const invitee = await newUser('Replay');
    const { token } = await inviteMember(orgSlug, { email: invitee.email, role: 'viewer' });

    user.id = invitee.id;
    await acceptInvitation(token);
    await expect(acceptInvitation(token)).rejects.toThrow(/already accepted/i);
  });

  it('rejects an expired invitation', async () => {
    user.id = ownerId;
    const invitee = await newUser('Late');
    const { token } = await inviteMember(orgSlug, { email: invitee.email, role: 'viewer' });
    await admin`
      update invitations set expires_at = now() - interval '1 day' where email = ${invitee.email}
    `;

    user.id = invitee.id;
    await expect(acceptInvitation(token)).rejects.toThrow(/expired/i);
  });

  it('rejects a revoked invitation', async () => {
    user.id = ownerId;
    const invitee = await newUser('Gone');
    const { token } = await inviteMember(orgSlug, { email: invitee.email, role: 'viewer' });
    const [invitation] = await admin`select id from invitations where email = ${invitee.email}`;
    await revokeInvitation(orgSlug, invitation.id as string);

    user.id = invitee.id;
    await expect(acceptInvitation(token)).rejects.toThrow(/revoked/i);
  });

  it('rejects an unknown token', async () => {
    user.id = staffId;
    await expect(acceptInvitation('totally-made-up-token')).rejects.toThrow();
  });

  it('rejects an unauthenticated caller', async () => {
    user.id = ownerId;
    const invitee = await newUser('Anon');
    const { token } = await inviteMember(orgSlug, { email: invitee.email, role: 'viewer' });

    user.id = '';
    await expect(acceptInvitation(token)).rejects.toThrow();
    user.id = ownerId;
  });
});

describe('permission boundaries', () => {
  it('blocks a bookkeeper from inviting or listing members', async () => {
    user.id = staffId; // 上面已接受成为 bookkeeper
    await expect(
      inviteMember(orgSlug, { email: 'another@example.com', role: 'viewer' }),
    ).rejects.toThrow(/cannot perform/i);
    await expect(listMembers(orgSlug)).rejects.toThrow(/cannot perform/i);
  });

  it('hides the company from a non-member entirely', async () => {
    const stranger = await newUser('Stranger');
    user.id = stranger.id;
    // 对非成员返回 not_found 而不是 forbidden，否则等于确认公司存在。
    await expect(listMembers(orgSlug)).rejects.toThrow(/not found/i);
  });
});

describe('changeMemberRole', () => {
  it('promotes a bookkeeper to admin', async () => {
    user.id = ownerId;
    const members = await listMembers(orgSlug);
    const target = members.find((m) => m.userId === staffId);

    await changeMemberRole(orgSlug, target!.membershipId, 'admin');

    const [row] = await admin`select role from memberships where id = ${target!.membershipId}`;
    expect(row.role).toBe('admin');
  });

  it('refuses to assign the owner role directly', async () => {
    user.id = ownerId;
    const members = await listMembers(orgSlug);
    const target = members.find((m) => m.role !== 'owner');

    await expect(
      changeMemberRole(orgSlug, target!.membershipId, 'owner' as never),
    ).rejects.toThrow();
  });

  it('refuses to change the current owner via this path', async () => {
    user.id = ownerId;
    const members = await listMembers(orgSlug);
    const owner = members.find((m) => m.role === 'owner');

    await expect(changeMemberRole(orgSlug, owner!.membershipId, 'admin')).rejects.toThrow(
      /ownership transfer/i,
    );
  });

  it('refuses a membership id from another company the caller also owns', async () => {
    // 关键：攻击者同时是两家公司的成员，所以 RLS 不会挡住这一行——
    // 唯一的防线是 findMembership 里的 organization_id 收窄。
    // 若换成只按 id 查，这个用例会挂。
    user.id = ownerId;
    const second = await createOrganization({
      name: 'Second Co',
      baseCurrency: 'MYR',
      timezone: 'Asia/Kuala_Lumpur',
    });
    const victim = await newUser('Victim');
    const { token } = await inviteMember(second.slug, { email: victim.email, role: 'viewer' });
    user.id = victim.id;
    await acceptInvitation(token);

    const [victimMembership] = await admin`
      select id from memberships
      where organization_id = ${second.id} and user_id = ${victim.id}
    `;

    try {
      user.id = ownerId;
      // 拿 orgSlug（第一家公司）的上下文去改第二家公司的成员，必须被拒。
      await expect(
        changeMemberRole(orgSlug, victimMembership.id as string, 'admin'),
      ).rejects.toThrow(/does not exist/i);

      const [after] = await admin`select role from memberships where id = ${victimMembership.id}`;
      expect(after.role).toBe('viewer');
    } finally {
      await deleteTestOrganizations([second.id]);
    }
  });
});

describe('setMemberStatus', () => {
  it('refuses to suspend the owner', async () => {
    user.id = ownerId;
    const members = await listMembers(orgSlug);
    const owner = members.find((m) => m.role === 'owner');

    await expect(setMemberStatus(orgSlug, owner!.membershipId, 'suspended')).rejects.toThrow();
  });

  it('suspends a member, blocks their access, then reactivates them', async () => {
    user.id = ownerId;
    const members = await listMembers(orgSlug);
    const target = members.find((m) => m.userId === staffId);

    await setMemberStatus(orgSlug, target!.membershipId, 'suspended');

    // 被暂停的成员看不到这家公司：resolveOrgContext 只 join status = 'active'。
    user.id = staffId;
    await expect(listMembers(orgSlug)).rejects.toThrow(/not found/i);

    user.id = ownerId;
    await setMemberStatus(orgSlug, target!.membershipId, 'active');
    const [row] = await admin`select status from memberships where id = ${target!.membershipId}`;
    expect(row.status).toBe('active');
  });
});

describe('listInvitations', () => {
  it('returns pending invitations without exposing token hashes', async () => {
    user.id = ownerId;
    const rows = await listInvitations(orgSlug);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.acceptedAt).toBeNull();
      expect(row.revokedAt).toBeNull();
      expect(Object.keys(row)).not.toContain('tokenHash');
    }
  });
});

describe('revokeInvitation', () => {
  it('refuses to revoke an invitation twice', async () => {
    user.id = ownerId;
    const invitee = await newUser('Twice');
    await inviteMember(orgSlug, { email: invitee.email, role: 'viewer' });
    const [invitation] = await admin`select id from invitations where email = ${invitee.email}`;

    await revokeInvitation(orgSlug, invitation.id as string);
    await expect(revokeInvitation(orgSlug, invitation.id as string)).rejects.toThrow(
      /no longer pending/i,
    );
  });
});

describe('transferOwnership', () => {
  it('demotes the previous owner to admin and promotes the target', async () => {
    user.id = ownerId;
    const members = await listMembers(orgSlug);
    const target = members.find((m) => m.userId === staffId);
    expect(target).toBeDefined();

    await transferOwnership(orgSlug, target!.membershipId);

    const rows = await admin`
      select user_id, role from memberships where organization_id = ${orgId}
    `;
    const byUser = new Map(rows.map((r) => [r.user_id as string, r.role as string]));
    expect(byUser.get(staffId)).toBe('owner');
    expect(byUser.get(ownerId)).toBe('admin');
  });

  it('blocks a non-owner from transferring ownership', async () => {
    user.id = ownerId; // 已被降级为 admin
    const members = await listMembers(orgSlug);
    const target = members.find((m) => m.userId === ownerId);

    await expect(transferOwnership(orgSlug, target!.membershipId)).rejects.toThrow(
      /cannot perform/i,
    );
  });
});
