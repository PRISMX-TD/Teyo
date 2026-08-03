// 验证 app_accept_invitation 自身的校验是否有效。
// members.test.ts 走的是 Server Action，应用层会先拦下过期/撤销的邀请，
// 数据库里的那几个 raise exception 因此从未被执行过。这里直接调函数绕开应用层，
// 确认即便应用层漏检，邀请也无法被兑换。
import { afterAll, beforeAll, expect, it } from 'vitest';
import { admin, createTestUser, deleteTestOrganizations, deleteTestUser } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { generateInvitationToken, hashToken } from '@/server/repositories/invitations';

let ownerId: string;
let orgId: string;
const users: string[] = [];

async function seedInvitation(email: string, overrides: string) {
  const { token, tokenHash } = generateInvitationToken();
  await admin`
    insert into invitations (organization_id, email, role, token_hash, expires_at, invited_by)
    values (${orgId}, ${email}, 'viewer', ${tokenHash},
            now() + interval '7 days', ${ownerId})
  `;
  if (overrides) {
    await admin.unsafe(
      `update invitations set ${overrides} where token_hash = '${hashToken(token)}'`,
    );
  }
  return token;
}

async function acceptRaw(token: string, userId: string) {
  return withTransaction(userId, (tx) =>
    tx`select app_accept_invitation(${hashToken(token)}, ${userId}) as id`,
  );
}

beforeAll(async () => {
  const owner = await createTestUser('DbGuardOwner');
  ownerId = owner.id;
  users.push(ownerId);

  const [org] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Db Guard Co', 'db-guard-co', 'MYR', ${ownerId}) returning id
  `;
  orgId = org.id as string;
  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${ownerId}, ${orgId}, 'owner', 'active')
  `;
});

afterAll(async () => {
  await deleteTestOrganizations([orgId]);
  for (const id of users) await deleteTestUser(id);
  await admin.end();
});

it('refuses an expired invitation at the database level', async () => {
  const invitee = await createTestUser('DbExpired');
  users.push(invitee.id);
  const token = await seedInvitation(invitee.email, "expires_at = now() - interval '1 day'");

  await expect(acceptRaw(token, invitee.id)).rejects.toThrow(/invitation_expired/);
});

it('refuses a revoked invitation at the database level', async () => {
  const invitee = await createTestUser('DbRevoked');
  users.push(invitee.id);
  const token = await seedInvitation(invitee.email, 'revoked_at = now()');

  await expect(acceptRaw(token, invitee.id)).rejects.toThrow(/invitation_revoked/);
});

it('refuses an unknown token at the database level', async () => {
  const invitee = await createTestUser('DbUnknown');
  users.push(invitee.id);

  await expect(acceptRaw('no-such-token', invitee.id)).rejects.toThrow(/invitation_not_found/);
});

it('refuses to accept the same invitation twice at the database level', async () => {
  const invitee = await createTestUser('DbTwice');
  users.push(invitee.id);
  const token = await seedInvitation(invitee.email, '');

  await acceptRaw(token, invitee.id);
  await expect(acceptRaw(token, invitee.id)).rejects.toThrow(/invitation_already_accepted/);
});
