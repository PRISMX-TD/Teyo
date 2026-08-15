import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { CHECKLIST_ACTIONS, getFirstRunChecklistState } from '@/server/repositories/dashboard';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { renameAccount } = await import('@/server/actions/accounts');
const { createContact } = await import('@/server/actions/contacts');
const { createTransaction } = await import('@/server/actions/transactions');
const { inviteMember } = await import('@/server/actions/members');

let ownerId: string;
let adminId: string;
let bookkeeperId: string;
let viewerId: string;
let orgId: string;
let orgSlug: string;
let accountsByCode: Record<string, string>;
let categoriesByAccountCode: Record<string, string>;

const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  await resetTestData();

  ownerId = await createTestUser(`owner-fr-${suffix}@example.com`, 'Owner');
  adminId = await createTestUser(`admin-fr-${suffix}@example.com`, 'Admin');
  bookkeeperId = await createTestUser(`book-fr-${suffix}@example.com`, 'Bookkeeper');
  viewerId = await createTestUser(`viewer-fr-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'First Run Co', `first-run-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  accountsByCode = org.accountsByCode;
  categoriesByAccountCode = org.categoriesByAccountCode;

  await joinOrg(adminId, orgId, 'admin');
  await joinOrg(bookkeeperId, orgId, 'bookkeeper');
  await joinOrg(viewerId, orgId, 'viewer');
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('getFirstRunChecklistState', () => {
  it('starts entirely false even though every org is seeded with cash/bank accounts', async () => {
    currentUserId = ownerId;
    const state = await withTransaction(ownerId, (tx) =>
      getFirstRunChecklistState(tx, orgId, 'owner'),
    );
    expect(state).toEqual({
      hasMoneyAccount: false,
      hasFirstTransaction: false,
      hasContact: false,
      hasInvitedSomeone: false,
    });
  });

  it('completes hasMoneyAccount from renaming a seeded account alone, with no new account ever created', async () => {
    currentUserId = ownerId;
    // 只改名字，不新建账户——这是店主对着一个叫 "Bank Account" 的科目最自然
    // 的第一反应，这一项不该因为「没建新账户」就永远打不上勾。
    await renameAccount(orgSlug, accountsByCode.bank, {
      nameEn: 'Maybank Savings',
      nameZh: '马银行储蓄',
    });

    const state = await withTransaction(ownerId, (tx) =>
      getFirstRunChecklistState(tx, orgId, 'owner'),
    );
    expect(state.hasMoneyAccount).toBe(true);

    // 确认这条断言是靠改名的分支成立的，不是因为顺便新建了账户——
    // 这个账户依然是种子科目。
    const [row] = await admin`select is_system from accounts where id = ${accountsByCode.bank}`;
    expect(row.is_system).toBe(true);
  });

  it('does not treat archiving/reactivating an account as a rename', async () => {
    currentUserId = ownerId;
    const { setAccountActive } = await import('@/server/actions/accounts');
    const other = await createTestOrgWithSeed(
      ownerId,
      'Toggle Only Co',
      `toggle-only-co-${suffix}`,
      'MYR',
    );

    // 停用最后一个资金账户之外的另一个，不涉及任何改名。
    await setAccountActive(other.slug, other.accountsByCode.bank, false);

    const state = await withTransaction(ownerId, (tx) =>
      getFirstRunChecklistState(tx, other.id, 'owner'),
    );
    // setAccountActive 写的 audit after 是 {isActive}，没有 nameEn/nameZh
    // 键，?| 不会命中；也没有新建过账户，is_system = false 那支也不命中。
    expect(state.hasMoneyAccount).toBe(false);
  });

  it('completes hasContact and hasFirstTransaction once each action really happens', async () => {
    currentUserId = ownerId;
    await createContact(orgSlug, { type: 'customer', name: 'Acme Supplies' });
    await createTransaction(orgSlug, {
      occurredOn: '2026-08-01',
      currency: 'MYR',
      description: 'first sale',
      clientUuid: randomUUID(),
      kind: 'income',
      amount: '100.00',
      moneyAccountId: accountsByCode.cash,
      categoryId: categoriesByAccountCode.sales,
    });

    const state = await withTransaction(ownerId, (tx) =>
      getFirstRunChecklistState(tx, orgId, 'owner'),
    );
    expect(state.hasContact).toBe(true);
    expect(state.hasFirstTransaction).toBe(true);
  });

  it('gives a bookkeeper their own real progress instead of a blanket false for every item', async () => {
    // bookkeeper 自己就能建交易（transaction:create），这一项对他们不该恒假。
    // 但账户/联系人/成员三项要求 account:manage 或 member:manage，
    // bookkeeper 没有，理应恒假——即便公司里这三项的真相都已经是 true
    // （上面两个 it 已经让 owner 把它们都做完了）。
    const state = await withTransaction(bookkeeperId, (tx) =>
      getFirstRunChecklistState(tx, orgId, 'bookkeeper'),
    );
    expect(state.hasFirstTransaction).toBe(true);
    expect(state.hasMoneyAccount).toBe(false);
    expect(state.hasContact).toBe(false);
    expect(state.hasInvitedSomeone).toBe(false);
  });

  it('never gives a bookkeeper or viewer a permanently-unticked, unreachable invite step', async () => {
    currentUserId = ownerId;
    await inviteMember(orgSlug, { email: `invitee-${suffix}@example.com`, role: 'bookkeeper' });

    const ownerState = await withTransaction(ownerId, (tx) =>
      getFirstRunChecklistState(tx, orgId, 'owner'),
    );
    const adminState = await withTransaction(adminId, (tx) =>
      getFirstRunChecklistState(tx, orgId, 'admin'),
    );
    const bookkeeperState = await withTransaction(bookkeeperId, (tx) =>
      getFirstRunChecklistState(tx, orgId, 'bookkeeper'),
    );
    const viewerState = await withTransaction(viewerId, (tx) =>
      getFirstRunChecklistState(tx, orgId, 'viewer'),
    );

    // owner/admin genuinely have member:manage, invitations RLS lets them read
    // the row, and settings/members will actually open for them — the item
    // must reflect the truth: an invite really was sent.
    expect(ownerState.hasInvitedSomeone).toBe(true);
    expect(adminState.hasInvitedSomeone).toBe(true);

    // bookkeeper/viewer lack member:manage, so settings/members is forbidden
    // to them. Their flag must be false because the step doesn't apply to
    // their role at all — not because invitations' RLS (owner/admin only)
    // silently emptied a real answer, which would be indistinguishable from
    // "never queried" while still rendering as a permanently-unticked,
    // dead-end link to a page requirePermission would reject them from.
    expect(can('bookkeeper', CHECKLIST_ACTIONS.hasInvitedSomeone)).toBe(false);
    expect(can('viewer', CHECKLIST_ACTIONS.hasInvitedSomeone)).toBe(false);
    expect(bookkeeperState.hasInvitedSomeone).toBe(false);
    expect(viewerState.hasInvitedSomeone).toBe(false);
  });
});
